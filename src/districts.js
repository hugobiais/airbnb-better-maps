// Hoodmaps "categorized districts" layer: GeoJSON polygons colored by
// category (Hipsters / Suits / Rich / etc.) with per-feature density
// driving the fill alpha relative to the user's master opacity slider.

import { state, PAGE_SOURCE } from "./state.js";
import {
  ensureHoodmapsData,
  getEffectiveHoodmapsMode,
  getHoodmapsAvailability,
} from "./hoodmaps-data.js";
import { resolveHoodmapsSlug } from "./hoodmaps-resolver.js";

export const CATEGORY_COLORS = {
  hipsters: "#ffc924",
  uni: "#1c5182",
  rich: "#2BDE73",
  suits: "#42a5ff",
  normies: "#ccc",
  tourists: "#ff4742",
  nightlife: "#9B51E0",
  crime: "#444",
};

export function refreshDistricts(map) {
  const entry = state.perMap.get(map);
  if (!entry) return;
  const hm = state.settings.hoodmaps || {};
  if (!state.settings.enabled || !hm.enabled) {
    if (entry.dataLayer) {
      entry.dataLayer.setMap(null);
      entry.dataLayer = null;
      entry.districtsSlug = null;
    }
    return;
  }
  const resolved = resolveHoodmapsSlug(map);
  if (entry.districtsRequestedSlug !== resolved.requestedSlug) {
    if (entry.dataLayer) {
      entry.dataLayer.setMap(null);
      entry.dataLayer = null;
      entry.districtsSlug = null;
    }
    entry.districtsRequestedSlug = resolved.requestedSlug;
  }
  if (!resolved.ready) return;
  const slug = resolved.slug;
  if (!slug) {
    if (entry.dataLayer) {
      entry.dataLayer.setMap(null);
      entry.dataLayer = null;
      entry.districtsSlug = null;
    }
    return;
  }

  // Slug changed (SPA navigation to a new destination): tear down the old
  // city's polygons immediately so we don't show stale shapes while waiting
  // for the new geojson fetch to complete.
  if (entry.dataLayer && entry.districtsSlug !== slug) {
    entry.dataLayer.setMap(null);
    entry.dataLayer = null;
    entry.districtsSlug = null;
  }

  ensureHoodmapsData(slug);
  const availability = getHoodmapsAvailability(slug);
  if (!availability.known) return;
  if (getEffectiveHoodmapsMode(slug) !== "districts") {
    if (entry.dataLayer) {
      entry.dataLayer.setMap(null);
      entry.dataLayer = null;
      entry.districtsSlug = null;
    }
    return;
  }
  if (!availability.districts) {
    if (entry.dataLayer) {
      entry.dataLayer.setMap(null);
      entry.dataLayer = null;
      entry.districtsSlug = null;
    }
    return;
  }

  const geojson = state.districtsBySlug.get(slug);
  if (!geojson) {
    if (!state.districtsPending.has(slug)) {
      state.districtsPending.add(slug);
      window.postMessage(
        { source: PAGE_SOURCE, type: "districtsRequest", slug },
        "*",
      );
    }
    return;
  }

  if (!entry.dataLayer || entry.districtsSlug !== slug) {
    if (entry.dataLayer) entry.dataLayer.setMap(null);
    const data = new google.maps.Data({ map });
    data.addGeoJson(geojson);
    entry.dataLayer = data;
    entry.districtsSlug = slug;
  }

  // Always re-apply style so per-category toggles + opacity slider take
  // effect immediately. The per-feature `opacity` is a relative density
  // signal we keep as a multiplier so dense zones still read stronger
  // than sparse ones at any master-opacity level.
  const cats = hm.categories || {};
  const maxFill = Math.max(0, Math.min(1, (hm.opacity ?? 35) / 100));
  entry.dataLayer.setStyle((feature) => {
    const cat = feature.getProperty("category");
    if (!cats[cat]) return { visible: false };
    const featureWeight = Number(feature.getProperty("opacity")) || 0.5;
    const color = CATEGORY_COLORS[cat] || "#888";
    const fillOpacity = maxFill * (0.4 + featureWeight * 0.6);
    const strokeOpacity = Math.min(1, fillOpacity * 1.2);
    return {
      fillColor: color,
      fillOpacity,
      strokeColor: color,
      strokeOpacity,
      strokeWeight: 1,
      clickable: false,
      zIndex: 0,
      visible: true,
    };
  });
}
