// Hoodmaps proxy helpers for tags and categorized districts.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});
  const { HOODMAPS_TTL_MS, cachedFetchJSON } = bridge;

  bridge.fetchHoodmapsTags = async function fetchHoodmapsTags(slug) {
    const j = await cachedFetchJSON(
      "hoodmaps:" + slug,
      HOODMAPS_TTL_MS,
      "https://hoodmaps.com/?action=get_data&slug=" + encodeURIComponent(slug),
    );
    if (!j || !Array.isArray(j.tags)) throw new Error("malformed");
    return j.tags
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
  };

  bridge.fetchHoodmapsDistricts = async function fetchHoodmapsDistricts(slug) {
    return cachedFetchJSON(
      "hoodmaps-districts:" + slug,
      HOODMAPS_TTL_MS,
      "https://hoodmaps.com/assets/districts_categorized/" +
        encodeURIComponent(slug) +
        ".geojson",
    );
  };
})();
