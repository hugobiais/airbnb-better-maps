// Tile geometry helpers for the isolated-world transit cache.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});
  const { TILE_SIZE } = bridge;

  // Tile grid: 0.05° squares, indexed by integer (tx, ty) where a tile covers
  // [ty*TS, (ty+1)*TS] lat × [tx*TS, (tx+1)*TS] lng. Caching per tile (instead
  // of per viewport bbox) lets a different viewport that covers the same area
  // reuse the same cache entries — the user's panning/zooming no longer
  // invalidates previously-loaded data.
  function tileBoundsFor(tx, ty) {
    const W = tx * TILE_SIZE;
    const S = ty * TILE_SIZE;
    return { S, W, N: S + TILE_SIZE, E: W + TILE_SIZE };
  }

  function tilesForBbox(S, W, N, E) {
    const txMin = Math.floor(W / TILE_SIZE);
    const txMax = Math.ceil(E / TILE_SIZE) - 1;
    const tyMin = Math.floor(S / TILE_SIZE);
    const tyMax = Math.ceil(N / TILE_SIZE) - 1;
    const tiles = [];
    for (let ty = tyMin; ty <= tyMax; ty++)
      for (let tx = txMin; tx <= txMax; tx++) tiles.push({ tx, ty });
    return tiles;
  }

  // Slice a feature into per-tile sub-features. Segments are clipped at tile
  // boundaries so a tile fetched in isolation still gets geometry that crosses
  // into it from a neighboring tile.
  function splitFeatureByTile(feature) {
    const out = new Map(); // "tx:ty" -> [{mode,color,path:[…]}, …]
    const path = feature.path;
    if (!Array.isArray(path) || path.length < 2) return out;

    const lastRuns = new Map();
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      for (const t of tilesForSegment(a, b)) {
        const clipped = clipSegmentToTile(a, b, t);
        if (clipped) {
          appendTileSegment(out, lastRuns, t, feature, clipped[0], clipped[1]);
        }
      }
    }
    return out;
  }

  function tilesForSegment(a, b) {
    const txMin = Math.floor(Math.min(a.lng, b.lng) / TILE_SIZE);
    const txMax = Math.floor(Math.max(a.lng, b.lng) / TILE_SIZE);
    const tyMin = Math.floor(Math.min(a.lat, b.lat) / TILE_SIZE);
    const tyMax = Math.floor(Math.max(a.lat, b.lat) / TILE_SIZE);
    const tiles = [];
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        tiles.push({ tx, ty });
      }
    }
    return tiles;
  }

  function clipSegmentToTile(a, b, tile) {
    const bounds = tileBoundsFor(tile.tx, tile.ty);
    const x0 = a.lng;
    const y0 = a.lat;
    const dx = b.lng - x0;
    const dy = b.lat - y0;
    let t0 = 0;
    let t1 = 1;

    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else if (p > 0) {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };

    if (
      !clip(-dx, x0 - bounds.W) ||
      !clip(dx, bounds.E - x0) ||
      !clip(-dy, y0 - bounds.S) ||
      !clip(dy, bounds.N - y0) ||
      t1 - t0 <= 1e-12
    ) {
      return null;
    }

    return [
      roundPoint({ lat: y0 + t0 * dy, lng: x0 + t0 * dx }),
      roundPoint({ lat: y0 + t1 * dy, lng: x0 + t1 * dx }),
    ];
  }

  function appendTileSegment(out, lastRuns, tile, feature, a, b) {
    if (samePoint(a, b)) return;
    const key = `${tile.tx}:${tile.ty}`;
    let arr = out.get(key);
    if (!arr) {
      arr = [];
      out.set(key, arr);
    }

    let run = lastRuns.get(key);
    if (!run || !samePoint(run.path[run.path.length - 1], a)) {
      run = { mode: feature.mode, color: feature.color, path: [a] };
      arr.push(run);
      lastRuns.set(key, run);
    }
    run.path.push(b);
  }

  function roundPoint(p) {
    return {
      lat: Math.round(p.lat * 1e5) / 1e5,
      lng: Math.round(p.lng * 1e5) / 1e5,
    };
  }

  function samePoint(a, b) {
    return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  }

  bridge.tileBoundsFor = tileBoundsFor;
  bridge.tilesForBbox = tilesForBbox;
  bridge.splitFeatureByTile = splitFeatureByTile;
})();
