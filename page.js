// Entry for the page MAIN-world script. Wires up the message bridge with
// bridge.js, hooks google.maps.Map so every map Airbnb creates gets
// registered, and dispatches refreshes across the layer modules.

import { state, PAGE_SOURCE, BRIDGE_SOURCE } from "./src/state.js";
import { isMapUrl } from "./src/utils.js";
import { refreshTransit } from "./src/transit.js";
import { refreshTags } from "./src/tags.js";
import { refreshDistricts } from "./src/districts.js";
import { refreshControls } from "./src/controls.js";

function refreshAll(map) {
  refreshTransit(map);
  refreshTags(map);
  refreshDistricts(map);
  refreshControls(map);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.source !== BRIDGE_SOURCE) return;
  if (e.data.type === "settings") {
    state.settings = e.data.settings;
    for (const m of state.maps) refreshAll(m);
  } else if (e.data.type === "tagsResponse") {
    state.tagsPending.delete(e.data.slug);
    if (e.data.tags) state.tagsBySlug.set(e.data.slug, e.data.tags);
    for (const m of state.maps) refreshTags(m);
  } else if (e.data.type === "districtsResponse") {
    state.districtsPending.delete(e.data.slug);
    if (e.data.geojson) state.districtsBySlug.set(e.data.slug, e.data.geojson);
    for (const m of state.maps) refreshDistricts(m);
  }
});

// Now that the listener is attached, ask bridge.js for the saved settings.
// Without this, bridge's initial fire-and-forget send can race with this
// script's async load and be lost — leaving us stuck on hardcoded defaults.
window.postMessage({ source: PAGE_SOURCE, type: "requestSettings" }, "*");

// Airbnb is an SPA: switching destinations changes the URL via pushState
// without a real navigation. The map's "idle" event re-runs transit + tags
// when the map pans, but it doesn't cover districts (and may not fire if
// the new viewport is identical). Patch history methods and listen for
// popstate so we re-run every layer when the pathname changes.
let lastPath = location.pathname;
function onMaybeNav() {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  for (const m of state.maps) refreshAll(m);
}
for (const k of ["pushState", "replaceState"]) {
  const orig = history[k];
  history[k] = function (...args) {
    const r = orig.apply(this, args);
    queueMicrotask(onMaybeNav);
    return r;
  };
}
window.addEventListener("popstate", onMaybeNav);

// Wait for google.maps.Map to exist, then wrap the constructor so every
// map instance Airbnb creates is registered. Airbnb often caches the
// constructor before we can wrap it, so the hook alone isn't reliable —
// we also poll the DOM and pick up any map instance we haven't seen yet.
let hooked = false;
setInterval(() => {
  if (!window.google || !window.google.maps || !window.google.maps.Map) return;
  if (!hooked) {
    hookMapConstructor();
    hooked = true;
  }
  // Only attach overlays on Airbnb pages that actually have a map (search
  // results, listing detail). On other pages the script idles. We re-check
  // each tick so SPA navigation back into a map page picks up the new map.
  if (!isMapUrl()) return;
  findExistingMaps().forEach(register);
}, 500);

function hookMapConstructor() {
  const Orig = google.maps.Map;
  function Wrapped(...args) {
    const m = new Orig(...args);
    register(m);
    return m;
  }
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  // Copy static enums (MapTypeId, etc.).
  for (const k of Object.keys(Orig)) {
    try {
      Wrapped[k] = Orig[k];
    } catch {}
  }
  google.maps.Map = Wrapped;
}

function findExistingMaps() {
  const found = new Set();
  for (const el of document.querySelectorAll("*")) {
    for (const k of Object.keys(el)) {
      try {
        const v = el[k];
        if (v && v instanceof google.maps.Map) found.add(v);
      } catch {}
    }
  }
  return [...found];
}

function register(map) {
  if (state.maps.has(map)) return;
  if (!isMapUrl()) return;
  state.maps.add(map);
  state.perMap.set(map, {
    polylines: [],
    lastBboxKey: null,
    fetching: false,
    tagOverlays: [],
    tagsSlug: null,
    dataLayer: null,
    districtsSlug: null,
    controlsHost: null,
    controlsSync: null,
  });
  map.addListener("idle", () => {
    refreshTransit(map);
    refreshTags(map);
  });
  refreshAll(map);
}
