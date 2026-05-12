// Storage-backed JSON cache helpers for isolated-world fetches.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});

  const cacheInflight = new Map();
  
  async function cachedFetchJSON(cacheKey, ttlMs, url, options) {
    const stored = await chrome.storage.local.get(cacheKey);
    const entry = stored[cacheKey];
    if (entry && Date.now() - entry.t < ttlMs) return entry.data;
  
    const inflight = cacheInflight.get(cacheKey);
    if (inflight) return inflight;
  
    const request = (async () => {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error("http " + r.status);
      const data = await r.json();
      try {
        await chrome.storage.local.set({ [cacheKey]: { t: Date.now(), data } });
      } catch (err) {
        console.warn("[abnb-better-maps] cache write failed:", cacheKey, err);
      }
      return data;
    })();
    cacheInflight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      cacheInflight.delete(cacheKey);
    }
  }

  bridge.cachedFetchJSON = cachedFetchJSON;
})();
