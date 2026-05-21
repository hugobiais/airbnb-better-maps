// Hoodmaps proxy helpers for tags, crowd-painted pixels, and categorized
// districts.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});
  const { HOODMAPS_TTL_MS, cachedFetchJSON } = bridge;

  bridge.fetchHoodmapsData = async function fetchHoodmapsData(slug) {
    const j = await cachedFetchJSON(
      "hoodmaps:" + slug,
      HOODMAPS_TTL_MS,
      "https://hoodmaps.com/?action=get_data&slug=" + encodeURIComponent(slug),
    );
    if (!j || !Array.isArray(j.tags)) throw new Error("malformed");
    const tags = normalizeTags(j.tags);
    const low = normalizePaths(j.oneDecimalLessAllUsersPaths);
    const high = normalizePaths(j.highZoomUsersPaths);
    return {
      tags,
      pixels: { low, high },
      capabilities: {
        tags: tags.length > 0,
        pixels: low.length > 0 || high.length > 0,
        districts: !!j.neighborhoodsGeoJSONAvailable,
      },
      districtsUrl:
        typeof j.neighborhoodsGeoJSONURL === "string"
          ? j.neighborhoodsGeoJSONURL
          : null,
    };
  };

  bridge.fetchHoodmapsTags = async function fetchHoodmapsTags(slug) {
    const data = await bridge.fetchHoodmapsData(slug);
    return data.tags;
  };

  bridge.fetchHoodmapsDistricts = async function fetchHoodmapsDistricts(slug) {
    const data = await bridge.fetchHoodmapsData(slug).catch(() => null);
    if (data && data.capabilities && !data.capabilities.districts)
      throw new Error("unavailable");
    const url =
      data && data.districtsUrl
        ? absoluteHoodmapsUrl(data.districtsUrl)
        : "https://hoodmaps.com/assets/districts_categorized/" +
          encodeURIComponent(slug) +
          ".geojson";
    return cachedFetchJSON(
      "hoodmaps-districts:" + slug,
      HOODMAPS_TTL_MS,
      url,
    );
  };

  function normalizeTags(tags) {
    return tags
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
  }

  function normalizePaths(paths) {
    if (!Array.isArray(paths)) return [];
    return paths
      .map((p) => {
        if (!Array.isArray(p)) return null;
        const lat = Number(p[0]);
        const lng = Number(p[1]);
        const category = typeof p[2] === "string" ? p[2] : "";
        const rawWeight = Number(p[3]);
        const weight = Number.isFinite(rawWeight) ? rawWeight : 0.5;
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          (lat === 0 && lng === 0) ||
          lat < -90 ||
          lat > 90 ||
          lng < -180 ||
          lng > 180 ||
          !category
        )
          return null;
        return [lat, lng, category, Math.max(0, Math.min(1, weight))];
      })
      .filter(Boolean);
  }

  function absoluteHoodmapsUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    return "https://hoodmaps.com" + path;
  }
})();
