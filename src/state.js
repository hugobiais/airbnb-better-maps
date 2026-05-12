// Shared state for the page-world scripts. Single source of truth for
// settings (kept in sync with bridge.js / chrome.storage) and per-map
// rendering state. Other modules import `state` and mutate it directly.

export const DEFAULT_SETTINGS = {
  enabled: true,
  transit: {
    enabled: true,
    modes: { subway: true, tram: false, light_rail: false, train: false },
  },
  hoodmaps: {
    enabled: false,
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

export const state = {
  settings: DEFAULT_SETTINGS,
  maps: new Set(),
  perMap: new WeakMap(),
  cache: new Map(),
  transitPending: new Map(),
  transitRequests: new Map(),
  tagsBySlug: new Map(),
  tagsPending: new Set(),
  districtsBySlug: new Map(),
  districtsPending: new Set(),
};

// postMessage source tags for the page<->bridge handshake.
export const PAGE_SOURCE = "abnb-transit-overlay-page";
export const BRIDGE_SOURCE = "abnb-transit-overlay";
