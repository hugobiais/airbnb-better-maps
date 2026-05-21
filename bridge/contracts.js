// Shared contracts for the isolated-world bridge scripts.
// Keep these values aligned with page-world state and popup storage usage.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});

  bridge.SETTINGS_KEY = "transitOverlay";
  bridge.PAGE_SOURCE = "abnb-transit-overlay-page";
  bridge.BRIDGE_SOURCE = "abnb-transit-overlay";
  bridge.HOODMAPS_TTL_MS = 24 * 60 * 60 * 1000;
  bridge.OVERPASS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  bridge.PERF_PREFIX = "[abnb-better-maps:perf]";
  bridge.VALID_MODES = ["subway", "tram", "light_rail", "train"];
  bridge.BBOX_PAD = 0.02;
  bridge.TILE_SIZE = 0.05;

  bridge.DEFAULTS = {
    enabled: true, // master switch
    transit: {
      enabled: true,
      modes: { subway: true, tram: false, light_rail: false, train: false },
    },
    hoodmaps: {
      enabled: false,
      mode: "districts",
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

  bridge.mergeSettings = function mergeSettings(saved) {
    saved = saved || {};
    return {
      ...bridge.DEFAULTS,
      ...saved,
      transit: {
        ...bridge.DEFAULTS.transit,
        ...(saved.transit || {}),
        modes: {
          ...bridge.DEFAULTS.transit.modes,
          ...((saved.transit && saved.transit.modes) || {}),
        },
      },
      hoodmaps: {
        ...bridge.DEFAULTS.hoodmaps,
        ...(saved.hoodmaps || {}),
        categories: {
          ...bridge.DEFAULTS.hoodmaps.categories,
          ...((saved.hoodmaps && saved.hoodmaps.categories) || {}),
        },
      },
    };
  };

  bridge.sendSettings = function sendSettings(settings) {
    window.postMessage(
      { source: bridge.BRIDGE_SOURCE, type: "settings", settings },
      "*",
    );
  };
})();
