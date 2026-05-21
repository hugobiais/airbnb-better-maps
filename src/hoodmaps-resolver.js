import { detectCitySlug } from "./utils.js";

const INDEX_URL = new URL(
  "../data/hoodmaps-coverage-index.json",
  import.meta.url,
);
const READY_EVENT = "abm:hoodmaps-index-ready";
const MAX_VIEWPORT_TILES = 2500;

let index = null;
let pending = null;
let loadError = null;

export function ensureHoodmapsIndex() {
  if (index || pending) return pending;
  pending = fetch(INDEX_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Hoodmaps coverage index HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((loaded) => {
      index = loaded;
      loadError = null;
      window.dispatchEvent(new CustomEvent(READY_EVENT));
      return index;
    })
    .catch((err) => {
      loadError = err;
      console.warn("[abnb-better-maps] Hoodmaps index load failed", err);
      window.dispatchEvent(new CustomEvent(READY_EVENT));
      return null;
    });
  return pending;
}

export function resolveHoodmapsSlug(map) {
  const requestedSlug = detectCitySlug();
  if (!requestedSlug) {
    return {
      ready: true,
      requestedSlug: null,
      slug: null,
      reason: "no-requested-slug",
      candidates: [],
      capabilities: null,
    };
  }

  ensureHoodmapsIndex();
  if (!index) {
    return {
      ready: !!loadError,
      requestedSlug,
      slug: loadError ? requestedSlug : null,
      reason: loadError ? "index-load-failed" : "index-loading",
      candidates: [],
      capabilities: null,
    };
  }

  const bounds = map && map.getBounds && map.getBounds();
  if (!bounds) {
    return {
      ready: false,
      requestedSlug,
      slug: null,
      reason: "map-bounds-pending",
      candidates: [],
      capabilities: null,
    };
  }

  const center = getBoundsCenter(bounds);
  if (!center) {
    return {
      ready: true,
      requestedSlug,
      slug: datasetExists(requestedSlug) ? requestedSlug : null,
      reason: "map-center-unavailable",
      candidates: [],
      capabilities: capabilitiesFor(requestedSlug),
    };
  }

  const counts = collectCandidates(bounds, center);
  const ranked = rankCandidates(counts, center);
  if (ranked.length) {
    return {
      ready: true,
      requestedSlug,
      slug: ranked[0].slug,
      reason:
        ranked.length === 1 ? "coverage-match" : "nearest-coverage-center",
      candidates: ranked,
      capabilities: capabilitiesFor(ranked[0].slug),
    };
  }

  if (datasetExists(requestedSlug)) {
    return {
      ready: true,
      requestedSlug,
      slug: requestedSlug,
      reason: "requested-slug-fallback",
      candidates: [],
      capabilities: capabilitiesFor(requestedSlug),
    };
  }

  return {
    ready: true,
    requestedSlug,
    slug: null,
    reason: "no-coverage-match",
    candidates: [],
    capabilities: null,
  };
}

export function getHoodmapsIndexStatus() {
  return {
    loaded: !!index,
    pending: !!pending && !index && !loadError,
    error: loadError ? String(loadError) : null,
  };
}

export { READY_EVENT as HOODMAPS_INDEX_READY_EVENT };

function collectCandidates(bounds, center) {
  const tileSize = Number(index.tileSize) || 0.05;
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const south = clampLat(Math.min(sw.lat(), ne.lat()));
  const north = clampLat(Math.max(sw.lat(), ne.lat()));
  const west = normalizeLng(sw.lng());
  const east = normalizeLng(ne.lng());
  const latStart = Math.floor(south / tileSize);
  const latEnd = Math.floor(north / tileSize);
  const lngRanges =
    east >= west
      ? [[west, east]]
      : [
          [west, 180],
          [-180, east],
        ];
  const lngIndexRanges = lngRanges.map(([from, to]) => [
    Math.floor(from / tileSize),
    Math.floor(to / tileSize),
  ]);
  const totalTiles = lngIndexRanges.reduce(
    (sum, [lngStart, lngEnd]) =>
      sum + (latEnd - latStart + 1) * (lngEnd - lngStart + 1),
    0,
  );
  const counts = new Map();

  if (totalTiles > MAX_VIEWPORT_TILES) {
    addTileCandidates(
      counts,
      Math.floor(center.lat / tileSize),
      Math.floor(center.lng / tileSize),
    );
    return counts;
  }

  for (let latIndex = latStart; latIndex <= latEnd; latIndex++) {
    for (const [lngStart, lngEnd] of lngIndexRanges) {
      for (let lngIndex = lngStart; lngIndex <= lngEnd; lngIndex++) {
        addTileCandidates(counts, latIndex, lngIndex);
      }
    }
  }
  return counts;
}

function addTileCandidates(counts, latIndex, lngIndex) {
  const slugs = index.tiles[`${latIndex}:${lngIndex}`];
  if (!Array.isArray(slugs)) return;
  for (const slug of slugs) counts.set(slug, (counts.get(slug) || 0) + 1);
}

function rankCandidates(counts, center) {
  return [...counts.entries()]
    .map(([slug, overlapTiles]) => {
      const dataset = index.datasets[slug];
      const datasetCenter = dataset && dataset.center;
      return {
        slug,
        overlapTiles,
        distanceKm: datasetCenter
          ? distanceKm(center.lat, center.lng, datasetCenter[0], datasetCenter[1])
          : Number.POSITIVE_INFINITY,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.distanceKm))
    .sort(
      (a, b) =>
        a.distanceKm - b.distanceKm ||
        b.overlapTiles - a.overlapTiles ||
        a.slug.localeCompare(b.slug),
    );
}

function datasetExists(slug) {
  return !!(index && index.datasets && index.datasets[slug]);
}

function capabilitiesFor(slug) {
  const dataset = index && index.datasets && index.datasets[slug];
  return dataset && dataset.capabilities ? dataset.capabilities : null;
}

function getBoundsCenter(bounds) {
  const center = bounds.getCenter && bounds.getCenter();
  if (!center) return null;
  const lat = center.lat();
  const lng = normalizeLng(center.lng());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: clampLat(lat), lng };
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

function normalizeLng(lng) {
  if (!Number.isFinite(lng)) return lng;
  let normalized = lng;
  while (normalized < -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const r = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
