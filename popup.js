const KEY = "transitOverlay";
const DEFAULTS = {
  enabled: true,
  transit: {
    enabled: true,
    modes: { subway: true, tram: false, light_rail: false, train: false },
  },
  hoodmaps: {
    enabled: false,
    mode: "districts",
    labels: true,
    opacity: 35,
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

const $ = (id) => document.getElementById(id);
const masterEl = $("masterEnabled");
const statusEl = $("mapStatus");
const statusTextEl = $("mapStatusText");
const cacheSizeEl = $("cacheSize");
const manageCacheBtn = $("manageCache");
const pageMain = $("pageMain");
const pageCache = $("pageCache");
const cacheBackBtn = $("cacheBack");
const cacheClearAllBtn = $("cacheClearAll");
const cacheListEl = $("cacheList");

const CACHE_PREFIXES = ["tile:", "hoodmaps:", "hoodmaps-districts:"];

function formatBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function isCacheKey(k) {
  return CACHE_PREFIXES.some((p) => k.startsWith(p));
}

async function refreshCacheSize() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(isCacheKey);
    let bytes = 0;
    if (chrome.storage.local.getBytesInUse && keys.length) {
      bytes = await chrome.storage.local.getBytesInUse(keys);
    } else {
      for (const k of keys) bytes += JSON.stringify(all[k]).length;
    }
    // Count groups (city+mode), not raw bbox-keyed entries — matches the
    // "Cached data" list which collapses bboxes into one row per group.
    const groupCount = new Set(
      keys.map((k) => classifyKey(k)?.groupKey).filter(Boolean),
    ).size;
    cacheSizeEl.textContent =
      formatBytes(bytes) + (groupCount ? ` · ${groupCount} entries` : "");
    manageCacheBtn.disabled = keys.length === 0;
  } catch {
    cacheSizeEl.textContent = "unavailable";
    manageCacheBtn.disabled = true;
  }
}

const MODE_LABELS = {
  subway: "Subway",
  tram: "Tram",
  light_rail: "Light rail",
  train: "Commuter rail",
};

function prettyCity(slug) {
  if (!slug || slug === "unknown") return "Unknown location";
  return slug
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function prettyModes(modesCsv) {
  if (!modesCsv) return "";
  return modesCsv
    .split(",")
    .map((m) => MODE_LABELS[m] || m)
    .join(" / ");
}

// Parse a cache key into a logical group. Groups merge multiple raw entries
// into one user-facing row (e.g. all bboxes for "Transit · Subway · Paris",
// or hoodmaps tags + districts for the same city).
function classifyKey(key) {
  // Tile-based cache: tile:<city>:<mode>:<tx>:<ty>
  if (key.startsWith("tile:")) {
    const parts = key.slice("tile:".length).split(":");
    const city = parts[0] || "unknown";
    const mode = parts[1] || "";
    return {
      groupKey: `transit|${city}|${mode}`,
      name: "Transit · " + (prettyModes(mode) || "—"),
      detail: prettyCity(city),
      sortHint: 0,
    };
  }
  if (key.startsWith("hoodmaps-districts:")) {
    const slug = key.slice("hoodmaps-districts:".length);
    return {
      groupKey: `hoodmaps|${slug}`,
      name: "Hoodmaps",
      detail: prettyCity(slug),
      sortHint: 1,
    };
  }
  if (key.startsWith("hoodmaps:")) {
    const slug = key.slice("hoodmaps:".length);
    return {
      groupKey: `hoodmaps|${slug}`,
      name: "Hoodmaps",
      detail: prettyCity(slug),
      sortHint: 1,
    };
  }
  return null;
}

async function renderCacheList() {
  cacheListEl.innerHTML = "";
  const all = await chrome.storage.local.get(null);
  const rawKeys = Object.keys(all).filter(isCacheKey);
  cacheClearAllBtn.hidden = rawKeys.length === 0;
  cacheClearAllBtn.disabled = false;

  // Bucket raw entries into logical groups, summing sizes and tracking the
  // underlying keys so the × button can wipe all of them at once.
  const groups = new Map();
  for (const key of rawKeys) {
    const cls = classifyKey(key);
    if (!cls) continue;
    const bytes = JSON.stringify(all[key]).length;
    let g = groups.get(cls.groupKey);
    if (!g) {
      g = {
        name: cls.name,
        detail: cls.detail,
        sortHint: cls.sortHint,
        bytes: 0,
        keys: [],
      };
      groups.set(cls.groupKey, g);
    }
    g.bytes += bytes;
    g.keys.push(key);
  }

  const ordered = [...groups.values()].sort((a, b) => b.bytes - a.bytes);

  if (!ordered.length) {
    const li = document.createElement("li");
    li.className = "cache-empty";
    li.textContent = "No cached data.";
    cacheListEl.appendChild(li);
    return;
  }

  for (const g of ordered) {
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = g.name;
    const detailEl = document.createElement("span");
    detailEl.className = "detail";
    detailEl.title = g.detail;
    detailEl.textContent = g.detail;
    meta.appendChild(nameEl);
    if (g.detail) meta.appendChild(detailEl);

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatBytes(g.bytes);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await chrome.storage.local.remove(g.keys);
      await renderCacheList();
      refreshCacheSize();
    });

    li.appendChild(meta);
    li.appendChild(size);
    li.appendChild(remove);
    cacheListEl.appendChild(li);
  }
}

function showCachePage() {
  pageMain.hidden = true;
  pageCache.hidden = false;
  renderCacheList();
}

function showMainPage() {
  pageCache.hidden = true;
  pageMain.hidden = false;
  refreshCacheSize();
}

async function load() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const s = saved || {};
  return {
    ...DEFAULTS,
    ...s,
    transit: {
      ...DEFAULTS.transit,
      ...(s.transit || {}),
      modes: {
        ...DEFAULTS.transit.modes,
        ...((s.transit && s.transit.modes) || {}),
      },
    },
    hoodmaps: {
      ...DEFAULTS.hoodmaps,
      ...(s.hoodmaps || {}),
      categories: {
        ...DEFAULTS.hoodmaps.categories,
        ...((s.hoodmaps && s.hoodmaps.categories) || {}),
      },
    },
  };
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusTextEl.textContent = text;
}

/** Align with manifest: *.airbnb.com + www.airbnb.<ccTLD> guest sites (HTTPS only). */
function isAirbnbGuestTabUrl(raw) {
  if (!raw || !raw.startsWith("https://")) return false;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "airbnb.com" || host.endsWith(".airbnb.com")) return true;
  return /^www\.airbnb\.[a-z0-9.-]+$/.test(host);
}

let consecutiveMisses = 0;
const MISS_TOLERANCE = 2;

async function checkMapStatus() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id || !isAirbnbGuestTabUrl(tab.url || "")) {
      consecutiveMisses = 0;
      setStatus("idle", "Not on an Airbnb page");
      return;
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        if (!window.google || !window.google.maps || !window.google.maps.Map)
          return "no-api";
        // Once we've seen a Map for this URL, trust it. Airbnb's SPA briefly
        // detaches/remounts the map container during filter/zoom interactions,
        // which made a fresh scan flicker between found/no-instance.
        const url = location.href;
        if (window.__abnbMapEverFound === url) return "found";
        for (const el of document.querySelectorAll("*")) {
          for (const k of Object.keys(el)) {
            try {
              if (el[k] instanceof google.maps.Map) {
                window.__abnbMapEverFound = url;
                return "found";
              }
            } catch {}
          }
        }
        return "no-instance";
      },
    });
    if (result === "found") {
      consecutiveMisses = 0;
      setStatus("found", "Map found");
    } else {
      consecutiveMisses++;
      // Hysteresis: don't flip back to "searching" on a single missed poll.
      if (
        statusEl.dataset.state === "found" &&
        consecutiveMisses < MISS_TOLERANCE
      )
        return;
      if (result === "no-api")
        setStatus("searching", "Waiting for Google Maps to load…");
      else if (result === "no-instance")
        setStatus("searching", "Map not on this view yet");
      else setStatus("error", "Couldn’t check map");
    }
  } catch {
    setStatus("error", "Status unavailable");
  }
}

(async () => {
  const s = await load();
  masterEl.checked = !!s.enabled;
  checkMapStatus();
  const interval = setInterval(checkMapStatus, 1500);
  window.addEventListener("blur", () => clearInterval(interval));

  masterEl.addEventListener("change", async () => {
    const cur = await load();
    cur.enabled = masterEl.checked;
    await save(cur);
  });

  refreshCacheSize();
  manageCacheBtn.addEventListener("click", showCachePage);
  cacheBackBtn.addEventListener("click", showMainPage);
  cacheClearAllBtn.addEventListener("click", async () => {
    cacheClearAllBtn.disabled = true;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(isCacheKey);
    if (keys.length) await chrome.storage.local.remove(keys);
    await renderCacheList();
    refreshCacheSize();
  });
})();
