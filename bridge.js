// Content script. Injects page.js into the page MAIN world, bridges
// chrome.storage <-> postMessage for settings, and serves as a network proxy
// for cross-origin fetches that benefit from chrome.storage caching.

// page.js is an ES module that imports the layer modules from src/. The
// browser handles dependency resolution; we just inject the entry.
const s = document.createElement("script");
s.src = chrome.runtime.getURL("page.js");
s.type = "module";
(document.head || document.documentElement).appendChild(s);

const SETTINGS_KEY = "transitOverlay";
const DEFAULTS = {
  enabled: true, // master switch
  transit: {
    enabled: true,
    modes: { subway: true, tram: true, light_rail: true, train: true },
  },
  hoodmaps: {
    enabled: false,
    labels: true, // text labels (the "names" — free-text crowdsourced tags)
    opacity: 35, // percent (0-100), applied to category zones
    categories: {
      hipsters: true,
      uni: true,
      rich: true,
      suits: true,
      normies: true,
      tourists: true,
      nightlife: true,
      crime: true,
    },
  },
};

function sendSettings(settings) {
  window.postMessage(
    { source: "abnb-transit-overlay", type: "settings", settings },
    "*",
  );
}

function merge(saved) {
  saved = saved || {};
  return {
    ...DEFAULTS,
    ...saved,
    transit: {
      ...DEFAULTS.transit,
      ...(saved.transit || {}),
      modes: {
        ...DEFAULTS.transit.modes,
        ...((saved.transit && saved.transit.modes) || {}),
      },
    },
    hoodmaps: {
      ...DEFAULTS.hoodmaps,
      ...(saved.hoodmaps || {}),
      categories: {
        ...DEFAULTS.hoodmaps.categories,
        ...((saved.hoodmaps && saved.hoodmaps.categories) || {}),
      },
    },
  };
}

chrome.storage.local
  .get(SETTINGS_KEY)
  .then(({ [SETTINGS_KEY]: saved }) => sendSettings(merge(saved)));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  sendSettings(merge(changes[SETTINGS_KEY].newValue));
});

// Hoodmaps proxy: page.js requests tags / districts by slug; we serve cached
// or fetch from hoodmaps and store in chrome.storage.local with a 24h TTL.
const HOODMAPS_TTL_MS = 24 * 60 * 60 * 1000;

async function cachedFetchJSON(cacheKey, url) {
  const stored = await chrome.storage.local.get(cacheKey);
  const entry = stored[cacheKey];
  if (entry && Date.now() - entry.t < HOODMAPS_TTL_MS) return entry.data;
  const r = await fetch(url);
  if (!r.ok) throw new Error("http " + r.status);
  const data = await r.json();
  await chrome.storage.local.set({ [cacheKey]: { t: Date.now(), data } });
  return data;
}

window.addEventListener("message", async (e) => {
  if (
    e.source !== window ||
    !e.data ||
    e.data.source !== "abnb-transit-overlay-page"
  )
    return;

  // Settings write from on-map controls. Persisting triggers
  // chrome.storage.onChanged below, which broadcasts the new settings back.
  if (e.data.type === "updateSettings" && e.data.settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: e.data.settings });
    return;
  }

  // page.js requests settings once it's ready. Avoids a race where bridge's
  // fire-and-forget initial send arrives before page.js attaches its listener.
  if (e.data.type === "requestSettings") {
    const { [SETTINGS_KEY]: saved } =
      await chrome.storage.local.get(SETTINGS_KEY);
    sendSettings(merge(saved));
    return;
  }

  const slug = e.data.slug;
  if (!slug) return;

  if (e.data.type === "tagsRequest") {
    try {
      const j = await cachedFetchJSON(
        "hoodmaps:" + slug,
        "https://hoodmaps.com/?action=get_data&slug=" +
          encodeURIComponent(slug),
      );
      if (!j || !Array.isArray(j.tags)) throw new Error("malformed");
      const tags = j.tags
        .filter(
          (t) =>
            t &&
            t.tag &&
            Number.isFinite(t.latitude) &&
            Number.isFinite(t.longitude),
        )
        .map((t) => ({
          lat: t.latitude,
          lng: t.longitude,
          text: t.tag,
          votes: t.votes | 0,
          sentiment: t.sentiment_score | 0,
        }));
      window.postMessage(
        { source: "abnb-transit-overlay", type: "tagsResponse", slug, tags },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: "abnb-transit-overlay",
          type: "tagsResponse",
          slug,
          error: String(err),
        },
        "*",
      );
    }
  } else if (e.data.type === "districtsRequest") {
    try {
      const geojson = await cachedFetchJSON(
        "hoodmaps-districts:" + slug,
        "https://hoodmaps.com/assets/districts_categorized/" +
          encodeURIComponent(slug) +
          ".geojson",
      );
      window.postMessage(
        {
          source: "abnb-transit-overlay",
          type: "districtsResponse",
          slug,
          geojson,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: "abnb-transit-overlay",
          type: "districtsResponse",
          slug,
          error: String(err),
        },
        "*",
      );
    }
  }
});
