// Content script entry. Injects page.js into the page MAIN world and bridges
// chrome.storage plus cross-origin fetch helpers to page.js over postMessage.

const bridge = globalThis.abmBridge;

// page.js is an ES module that imports the layer modules from src/. The
// browser handles dependency resolution; we just inject the entry.
const s = document.createElement("script");
s.src = chrome.runtime.getURL("page.js");
s.type = "module";
(document.head || document.documentElement).appendChild(s);

chrome.storage.local
  .get(bridge.SETTINGS_KEY)
  .then(({ [bridge.SETTINGS_KEY]: saved }) =>
    bridge.sendSettings(bridge.mergeSettings(saved)),
  );

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[bridge.SETTINGS_KEY]) return;
  bridge.sendSettings(bridge.mergeSettings(changes[bridge.SETTINGS_KEY].newValue));
});

window.addEventListener("message", async (e) => {
  if (
    e.source !== window ||
    !e.data ||
    e.data.source !== bridge.PAGE_SOURCE
  )
    return;

  // Settings write from on-map controls. Persisting triggers
  // chrome.storage.onChanged below, which broadcasts the new settings back.
  if (e.data.type === "updateSettings" && e.data.settings) {
    await chrome.storage.local.set({ [bridge.SETTINGS_KEY]: e.data.settings });
    return;
  }

  // page.js requests settings once it's ready. Avoids a race where bridge's
  // fire-and-forget initial send arrives before page.js attaches its listener.
  if (e.data.type === "requestSettings") {
    const { [bridge.SETTINGS_KEY]: saved } = await chrome.storage.local.get(
      bridge.SETTINGS_KEY,
    );
    bridge.sendSettings(bridge.mergeSettings(saved));
    return;
  }

  if (e.data.type === "transitRequest") {
    const bboxKey = e.data.bboxKey;
    const modes = Array.isArray(e.data.modes) ? e.data.modes : [];
    const requestKey = e.data.requestKey || bboxKey;
    const citySlug =
      typeof e.data.citySlug === "string" && e.data.citySlug
        ? e.data.citySlug
        : "unknown";
    if (!bboxKey) return;
    try {
      const features = await bridge.fetchTransitTiles(citySlug, bboxKey, modes);
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "transitResponse",
          bboxKey,
          requestKey,
          features,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "transitResponse",
          bboxKey,
          requestKey,
          error: String(err),
        },
        "*",
      );
    }
    return;
  }

  const slug = e.data.slug;
  if (!slug) return;

  if (e.data.type === "tagsRequest") {
    try {
      const data = await bridge.fetchHoodmapsData(slug);
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "tagsResponse",
          slug,
          tags: data.tags,
          pixels: data.pixels,
          capabilities: data.capabilities,
          districtsUrl: data.districtsUrl,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "tagsResponse",
          slug,
          error: String(err),
        },
        "*",
      );
    }
  } else if (e.data.type === "hoodmapsDataRequest") {
    try {
      const data = await bridge.fetchHoodmapsData(slug);
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "hoodmapsDataResponse",
          slug,
          tags: data.tags,
          pixels: data.pixels,
          capabilities: data.capabilities,
          districtsUrl: data.districtsUrl,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "hoodmapsDataResponse",
          slug,
          error: String(err),
        },
        "*",
      );
    }
  } else if (e.data.type === "districtsRequest") {
    try {
      const geojson = await bridge.fetchHoodmapsDistricts(slug);
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "districtsResponse",
          slug,
          geojson,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          source: bridge.BRIDGE_SOURCE,
          type: "districtsResponse",
          slug,
          error: String(err),
        },
        "*",
      );
    }
  }
});
