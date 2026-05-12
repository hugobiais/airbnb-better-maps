// Transit tile cache orchestration and Overpass fetch flow.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});
  const {
    BBOX_PAD,
    OVERPASS_TTL_MS,
    PERF_PREFIX,
    VALID_MODES,
    buildOverpassQueryForBbox,
    parseOverpassToFeatures,
    splitFeatureByTile,
    tileBoundsFor,
    tilesForBbox,
  } = bridge;

  const transitInflight = new Map();
  
  async function fetchTransitTiles(citySlug, bboxKey, requestedModes) {
    const startedAt = performance.now();
    const modes = (Array.isArray(requestedModes) ? requestedModes : [])
      .filter((m) => VALID_MODES.includes(m))
      .sort();
    if (!modes.length) throw new Error("no modes");
  
    const parts = bboxKey.split(",").map(Number);
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v)))
      throw new Error("bad bbox");
    const [s, w, n, e] = parts;
    const tiles = tilesForBbox(s - BBOX_PAD, w - BBOX_PAD, n + BBOX_PAD, e + BBOX_PAD);
    if (!tiles.length) return [];
  
    const tileKey = (mode, t) =>
      `tile:${citySlug}:${mode}:${t.tx}:${t.ty}`;
  
    // Build the full request set: every (mode, tile) combination.
    const requested = [];
    for (const mode of modes)
      for (const t of tiles)
        requested.push({ mode, t, key: tileKey(mode, t) });
  
    const storageStartedAt = performance.now();
    const stored = await chrome.storage.local.get(requested.map((x) => x.key));
    const storageReadMs = performance.now() - storageStartedAt;
    const now = Date.now();
    const cached = new Map(); // key -> features[]
    const missing = [];
    for (const x of requested) {
      const entry = stored[x.key];
      if (
        entry &&
        now - entry.t < OVERPASS_TTL_MS &&
        Array.isArray(entry.features)
      ) {
        cached.set(x.key, entry.features);
      } else {
        missing.push(x);
      }
    }
  
    // Coalesce: if a (mode, tile) is already in flight from a parallel call,
    // wait for that promise instead of re-fetching.
    const stillMissing = [];
    const inflightAwaits = [];
    for (const x of missing) {
      const inflight = transitInflight.get(x.key);
      if (inflight) inflightAwaits.push(inflight.then((feats) => [x.key, feats]));
      else stillMissing.push(x);
    }
  
    let overpassFetchMs = 0;
    let overpassJsonMs = 0;
    let parseMs = 0;
    let storageWriteMs = 0;
    let parsedFeatures = 0;
  
    if (stillMissing.length) {
      // Compute the union bbox of all still-missing tiles and the union of
      // modes needed for them. One Overpass query covers all of it; we then
      // distribute features into per-(mode, tile) buckets.
      let unionS = Infinity,
        unionW = Infinity,
        unionN = -Infinity,
        unionE = -Infinity;
      const missingModes = new Set();
      const missingKeys = new Set();
      for (const x of stillMissing) {
        missingModes.add(x.mode);
        missingKeys.add(x.key);
        const b = tileBoundsFor(x.t.tx, x.t.ty);
        if (b.S < unionS) unionS = b.S;
        if (b.W < unionW) unionW = b.W;
        if (b.N > unionN) unionN = b.N;
        if (b.E > unionE) unionE = b.E;
      }
  
      const queryModes = [...missingModes];
      const fetchPromise = (async () => {
        const query = buildOverpassQueryForBbox(
          unionS,
          unionW,
          unionN,
          unionE,
          queryModes,
        );
        const overpassStartedAt = performance.now();
        const r = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });
        overpassFetchMs = performance.now() - overpassStartedAt;
        if (!r.ok) throw new Error("http " + r.status);
        const jsonStartedAt = performance.now();
        const combined = await r.json();
        overpassJsonMs = performance.now() - jsonStartedAt;
        if (combined && typeof combined.remark === "string") {
          throw new Error("overpass " + combined.remark);
        }
        if (!combined || !Array.isArray(combined.elements)) {
          throw new Error("overpass malformed response");
        }
        const parseStartedAt = performance.now();
        const features = parseOverpassToFeatures(combined, queryModes);
        parseMs = performance.now() - parseStartedAt;
        parsedFeatures = features.length;
  
        // Bucket into the missing keys we're going to write. Tiles that end
        // up empty still get a sentinel `{features: []}` entry so we don't
        // refetch them next time.
        const byKey = new Map();
        for (const x of stillMissing) byKey.set(x.key, []);
        for (const f of features) {
          const subTiles = splitFeatureByTile(f);
          for (const [tileKeyStr, subFeats] of subTiles) {
            const [txStr, tyStr] = tileKeyStr.split(":");
            const k = tileKey(f.mode, { tx: txStr, ty: tyStr });
            // Only write into tiles we asked for (the union bbox can leak
            // into already-cached tiles or non-requested modes; ignore those).
            if (!missingKeys.has(k)) continue;
            const arr = byKey.get(k);
            for (const sf of subFeats) arr.push(sf);
          }
        }
  
        const writes = {};
        const t = Date.now();
        for (const [k, feats] of byKey) writes[k] = { t, features: feats };
        const writeStartedAt = performance.now();
        try {
          await chrome.storage.local.set(writes);
        } catch (err) {
          console.warn("[abnb-better-maps] cache write failed:", err);
        } finally {
          storageWriteMs = performance.now() - writeStartedAt;
        }
        return byKey;
      })();
  
      for (const x of stillMissing) {
        const p = fetchPromise.then((byKey) => byKey.get(x.key) || []);
        transitInflight.set(x.key, p);
        p.finally(() => {
          if (transitInflight.get(x.key) === p) transitInflight.delete(x.key);
        }).catch(() => {});
      }
  
      const byKey = await fetchPromise;
      for (const x of stillMissing) cached.set(x.key, byKey.get(x.key) || []);
    }
  
    for (const [k, feats] of await Promise.all(inflightAwaits)) {
      cached.set(k, feats);
    }
  
    // Union all the per-tile feature lists for the response.
    const out = [];
    for (const x of requested) {
      const feats = cached.get(x.key);
      if (Array.isArray(feats)) for (const f of feats) out.push(f);
    }
    console.log(PERF_PREFIX, "transit tiles", {
      citySlug,
      bboxKey,
      modes,
      tiles: tiles.length,
      requested: requested.length,
      storageHits: requested.length - missing.length,
      missing: missing.length,
      inflight: inflightAwaits.length,
      fetched: stillMissing.length,
      storageReadMs: roundMs(storageReadMs),
      overpassFetchMs: roundMs(overpassFetchMs),
      overpassJsonMs: roundMs(overpassJsonMs),
      parseMs: roundMs(parseMs),
      storageWriteMs: roundMs(storageWriteMs),
      totalMs: roundMs(performance.now() - startedAt),
      parsedFeatures,
      features: out.length,
    });
    return out;
  }
  
  function roundMs(ms) {
    return Math.round(ms * 10) / 10;
  }

  bridge.fetchTransitTiles = fetchTransitTiles;
})();
