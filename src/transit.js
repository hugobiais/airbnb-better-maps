// Transit lines layer: receives parsed, simplified, mode-bucketed polyline
// features from the bridge's Overpass proxy and renders them via
// google.maps.Polyline. Parsing/stitching/simplification all happen in
// bridge.js so the cache stores render-ready geometry.

import { state, PAGE_SOURCE } from "./state.js";
import { quantizeBbox, detectCitySlug } from "./utils.js";

// Fallbacks when OSM has no `colour` tag for a route.
const MODE_FALLBACK_COLORS = {
  subway: "#0066B3",
  tram: "#E60012",
  light_rail: "#8E44AD",
  train: "#2E7D32",
};
const MODE_WEIGHT = { subway: 2.5, tram: 2, light_rail: 2, train: 2 };
const MODE_Z = { train: 1, light_rail: 2, tram: 3, subway: 4 };
const PERF_PREFIX = "[abnb-better-maps:perf]";

export async function refreshTransit(map) {
  const startedAt = performance.now();
  const entry = state.perMap.get(map);
  if (!entry) return;

  if (!isTransitEnabled()) {
    clearPolylines(entry);
    entry.lastFeatures = null;
    entry.lastBboxKey = null;
    setTransitLoading(entry, false, map);
    return;
  }

  // Skip the fetch when the viewport spans more than ~1° in either axis.
  // Without this, a zoomed-out view (country/continent) would ask Overpass
  // for every rail relation in that box — commuter rail alone can return
  // 100+ MB across a country. We leave any existing polylines on the map so
  // the user keeps their context while zoomed out; new data only loads once
  // they zoom back in.
  if (viewportTooLarge(map)) {
    entry.loadingModes = null;
    setTransitLoading(entry, false, map);
    return;
  }

  const bboxKey = currentBboxKey(map);
  if (!bboxKey) return;

  if (entry.fetching) {
    if (entry.fetchingBboxKey !== bboxKey) entry.needsTransitRefresh = true;
    setTransitLoading(entry, true, map);
    console.log(PERF_PREFIX, "transit deferred", {
      bboxKey,
      fetchingBboxKey: entry.fetchingBboxKey,
      totalMs: roundMs(performance.now() - startedAt),
    });
    return;
  }

  const modes = enabledModeList();
  if (!modes.length) {
    clearPolylines(entry);
    entry.lastFeatures = null;
    entry.lastBboxKey = null;
    entry.lastModes = [];
    entry.loadingModes = null;
    setTransitLoading(entry, false, map);
    return;
  }
  const requestKey = modes.join(",") + "|" + bboxKey;

  let features;
  let source = "bridge";
  let fetchMs = 0;
  const previousModesForCheck = entry.lastModes || [];
  const isSubsetOfLast =
    entry.lastFeatures &&
    entry.lastBboxKey === bboxKey &&
    modes.every((m) => previousModesForCheck.includes(m));
  if (entry.lastRequestKey === requestKey && entry.lastFeatures) {
    // bbox + mode set unchanged — just redraw.
    source = "per-map";
    features = entry.lastFeatures;
  } else if (isSubsetOfLast) {
    // Mode set shrank (e.g., user unticked one). The render loop filters by
    // enabled modes, so drop the network round-trip and redraw locally.
    source = "per-map-subset";
    features = entry.lastFeatures;
    entry.lastRequestKey = requestKey;
    entry.lastModes = modes.slice();
  } else {
    entry.fetching = true;
    entry.fetchingBboxKey = bboxKey;
    // Per-row spinner is for newly enabled modes only. If the fetch is for a
    // bbox change with the same mode set, we leave loadingModes null so the
    // already-rendered rows don't flash a spinner — only the pill spins.
    const previousModes = entry.lastModes || [];
    const newlyAdded = modes.filter((m) => !previousModes.includes(m));
    entry.loadingModes = newlyAdded.length ? new Set(newlyAdded) : null;
    setTransitLoading(entry, true, map);
    let fetchStartedAt = 0;
    try {
      source = state.cache.has(requestKey)
        ? "page-cache"
        : state.transitRequests.has(requestKey)
          ? "page-inflight"
          : "bridge";
      fetchStartedAt = performance.now();
      features = await fetchTransit(bboxKey, modes, requestKey);
      fetchMs = performance.now() - fetchStartedAt;
      if (!isTransitEnabled()) return;
      if (currentBboxKey(map) !== bboxKey) {
        entry.needsTransitRefresh = true;
        return;
      }
      entry.lastBboxKey = bboxKey;
      entry.lastRequestKey = requestKey;
      entry.lastFeatures = features;
      entry.lastModes = modes.slice();
    } catch (err) {
      if (fetchStartedAt) fetchMs = performance.now() - fetchStartedAt;
      console.warn("[abnb-better-maps] Overpass fetch failed:", err, {
        bboxKey,
        source,
        fetchMs: roundMs(fetchMs),
      });
      return;
    } finally {
      entry.fetching = false;
      entry.fetchingBboxKey = null;
      entry.loadingModes = null;
      setTransitLoading(entry, false, map);
      if (entry.needsTransitRefresh) {
        entry.needsTransitRefresh = false;
        refreshTransit(map);
      }
    }
  }

  const renderStartedAt = performance.now();
  clearPolylines(entry);
  let drawn = 0;
  let points = 0;
  const enabledModes =
    (state.settings.transit && state.settings.transit.modes) || {};
  for (const f of features) {
    if (!enabledModes[f.mode]) continue;
    points += Array.isArray(f.path) ? f.path.length : 0;
    const polyline = new google.maps.Polyline({
      path: f.path,
      strokeColor: f.color || MODE_FALLBACK_COLORS[f.mode] || "#444",
      strokeOpacity: 0.7,
      strokeWeight: MODE_WEIGHT[f.mode] || 2,
      clickable: false,
      zIndex: MODE_Z[f.mode] || 1,
      geodesic: false,
      map,
    });
    entry.polylines.push(polyline);
    drawn++;
  }
  console.log(PERF_PREFIX, "transit refresh", {
    bboxKey,
    modes,
    source,
    fetchMs: roundMs(fetchMs),
    renderMs: roundMs(performance.now() - renderStartedAt),
    totalMs: roundMs(performance.now() - startedAt),
    features: features.length,
    drawn,
    points,
  });
}

function clearPolylines(entry) {
  for (const p of entry.polylines) p.setMap(null);
  entry.polylines = [];
}

async function fetchTransit(bboxKey, modes, requestKey) {
  if (state.cache.has(requestKey)) return state.cache.get(requestKey);
  const inflight = state.transitRequests.get(requestKey);
  if (inflight) return inflight;

  const citySlug = detectCitySlug() || "unknown";
  const request = new Promise((resolve, reject) => {
    state.transitPending.set(requestKey, { resolve, reject });
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "transitRequest",
        bboxKey,
        modes,
        citySlug,
        requestKey,
      },
      "*",
    );
  })
    .then((features) => {
      state.cache.set(requestKey, features);
      return features;
    })
    .finally(() => {
      state.transitRequests.delete(requestKey);
    });
  state.transitRequests.set(requestKey, request);
  return request;
}

export function handleTransitResponse(msg) {
  const key = msg.requestKey || msg.bboxKey;
  const pending = state.transitPending.get(key);
  if (!pending) return;
  state.transitPending.delete(key);
  if (msg.error) {
    pending.reject(new Error(msg.error));
    return;
  }
  if (!Array.isArray(msg.features)) {
    pending.reject(new Error("malformed"));
    return;
  }
  pending.resolve(msg.features);
}

function isTransitEnabled() {
  return !!(
    state.settings.enabled &&
    state.settings.transit &&
    state.settings.transit.enabled
  );
}

const VALID_MODES = ["subway", "tram", "light_rail", "train"];
function enabledModeList() {
  const m = (state.settings.transit && state.settings.transit.modes) || {};
  return VALID_MODES.filter((k) => m[k]);
}

function currentBboxKey(map) {
  const bounds = map.getBounds();
  if (!bounds) return null;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  return quantizeBbox(sw.lat(), sw.lng(), ne.lat(), ne.lng());
}

const MAX_BBOX_SPAN_DEG = 1;
function viewportTooLarge(map) {
  const bounds = map.getBounds();
  if (!bounds) return false;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const latSpan = ne.lat() - sw.lat();
  let lngSpan = ne.lng() - sw.lng();
  if (lngSpan < 0) lngSpan += 360; // antimeridian wrap
  return latSpan > MAX_BBOX_SPAN_DEG || lngSpan > MAX_BBOX_SPAN_DEG;
}

function setTransitLoading(entry, loading, map) {
  if (entry.transitLoading === loading) return;
  entry.transitLoading = loading;
  if (entry.controlsSync) entry.controlsSync(state.settings, entry, map);
}

function roundMs(ms) {
  return Math.round(ms * 10) / 10;
}
