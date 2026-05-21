import { state, PAGE_SOURCE } from "./state.js";

export function ensureHoodmapsData(slug) {
  if (!slug) return;
  if (
    state.hoodmapsCapabilitiesBySlug.has(slug) ||
    state.hoodmapsDataPending.has(slug)
  )
    return;
  state.hoodmapsDataPending.add(slug);
  window.postMessage(
    { source: PAGE_SOURCE, type: "hoodmapsDataRequest", slug },
    "*",
  );
}

export function applyHoodmapsDataResponse(msg) {
  const slug = msg && msg.slug;
  if (!slug) return;
  state.hoodmapsDataPending.delete(slug);
  state.tagsPending.delete(slug);

  if (Array.isArray(msg.tags)) state.tagsBySlug.set(slug, msg.tags);
  if (msg.pixels) {
    state.pixelPathsBySlug.set(slug, {
      low: Array.isArray(msg.pixels.low) ? msg.pixels.low : [],
      high: Array.isArray(msg.pixels.high) ? msg.pixels.high : [],
    });
  }
  if (msg.capabilities) {
    const caps = {
      districts: !!msg.capabilities.districts,
      pixels: !!msg.capabilities.pixels,
      tags: !!msg.capabilities.tags,
    };
    state.hoodmapsCapabilitiesBySlug.set(slug, caps);
    if (!caps.districts) state.districtsUnavailableBySlug.add(slug);
  }
}

export function getHoodmapsAvailability(slug) {
  const caps = state.hoodmapsCapabilitiesBySlug.get(slug);
  const pixels = state.pixelPathsBySlug.get(slug);
  return {
    known: !!caps,
    districts: state.districtsBySlug.has(slug) || !!(caps && caps.districts),
    pixels:
      !!(pixels && (pixels.low.length || pixels.high.length)) ||
      !!(caps && caps.pixels),
  };
}

export function getEffectiveHoodmapsMode(slug) {
  const availability = getHoodmapsAvailability(slug);
  if (!availability.known) return null;
  if (availability.districts && availability.pixels) {
    return state.settings.hoodmaps &&
      state.settings.hoodmaps.mode === "pixels"
      ? "pixels"
      : "districts";
  }
  if (availability.districts) return "districts";
  if (availability.pixels) return "pixels";
  return null;
}

