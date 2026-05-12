// Overpass query construction and response parsing for transit features.

(() => {
  const bridge = (globalThis.abmBridge = globalThis.abmBridge || {});
  const { VALID_MODES } = bridge;

  // Inspired by plepe/ptmap. We fetch matching route relations (cheap — just
  // metadata + member ID lists), then pull only the member ways INSIDE the
  // bbox plus their nodes. This avoids downloading hundreds of km of
  // off-screen TGV/TER geometry just because a route briefly enters the
  // viewport. `out skel` on ways/nodes strips tags we don't use.
  function buildOverpassQueryForBbox(S, W, N, E, modes) {
    const filtered = (Array.isArray(modes) ? modes : []).filter((m) =>
      VALID_MODES.includes(m),
    );
    if (!filtered.length) throw new Error("no modes");
    const alt = filtered.join("|");
    return `
      [out:json][timeout:25][bbox:${S},${W},${N},${E}];
      relation["type"="route"]["route"~"^(${alt})$"]->.routes;
      .routes out body;
      way(r.routes)(${S},${W},${N},${E})->.ways;
      .ways out skel;
      node(w.ways)->.geometry;
      .geometry out skel qt;
    `;
  }

  // Parse a combined Overpass response into the small, render-ready features
  // list that the page actually draws. Each feature is a stitched polyline
  // path keyed by (mode, color), with coordinates simplified (~3 m) and
  // quantized to 5 decimals (~1 m). Storing this instead of raw Overpass JSON
  // shrinks the cache by ~20-50× — the heavy parts (full node objects, way
  // member arrays, relation member ID lists, OSM tags) are dropped.
  const SIMPLIFY_DEG = 0.00003;

  function normalizeColorBridge(c) {
    if (!c) return null;
    if (/^#?[0-9a-f]{6}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
    if (/^#?[0-9a-f]{3}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
    return c;
  }

  function douglasPeuckerBridge(path, eps) {
    if (path.length < 3) return path;
    const sqEps = eps * eps;
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack = [[0, path.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxSq = 0,
        idx = -1;
      const a = path[s],
        b = path[e];
      for (let i = s + 1; i < e; i++) {
        const d = sqDistToSegmentBridge(path[i], a, b);
        if (d > maxSq) {
          maxSq = d;
          idx = i;
        }
      }
      if (maxSq > sqEps && idx > 0) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    const out = [];
    for (let i = 0; i < path.length; i++) if (keep[i]) out.push(path[i]);
    return out;
  }

  function sqDistToSegmentBridge(p, a, b) {
    const dx = b.lng - a.lng,
      dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = p.lng - (a.lng + t * dx);
    const ey = p.lat - (a.lat + t * dy);
    return ex * ex + ey * ey;
  }

  function trackWayCount(rel) {
    let n = 0;
    for (const m of rel.members || []) {
      if (m.type !== "way") continue;
      const role = m.role || "";
      if (role === "" || role === "forward" || role === "backward") n++;
    }
    return n;
  }

  function routeGroupKey(rel) {
    const t = rel.tags;
    const ref = t.ref || "";
    const network = t.network || t.operator || "";
    const color = t.colour || t.color || "";
    const ident = ref || color;
    return [t.route, network, ident].join("|");
  }

  function ingestRouteWays(rel, mode, color, ways, seen) {
    for (const m of rel.members || []) {
      if (m.type !== "way") continue;
      const role = m.role || "";
      if (role !== "" && role !== "forward" && role !== "backward") continue;
      const key = mode + ":" + m.ref;
      const existing = seen.get(key);
      if (existing && existing.color) continue;
      const wn = ways.get(m.ref);
      if (!wn || wn.length < 2) continue;
      seen.set(key, { mode, color, nodeIds: wn });
    }
  }

  function parseOverpassToFeatures(json, modesFilter) {
    const allowed = new Set(modesFilter);
    const nodes = new Map();
    const ways = new Map();
    const routes = [];
    const elements = (json && json.elements) || [];
    for (const el of elements) {
      if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
      else if (el.type === "way") ways.set(el.id, el.nodes);
      else if (
        el.type === "relation" &&
        el.tags &&
        el.tags.type === "route" &&
        allowed.has(el.tags.route)
      ) {
        routes.push(el);
      }
    }

    // Collapse direction-pair routes (same line, different `from`/`to`) by
    // grouping on route+network+ref+colour and keeping the variant with the
    // most track-way members.
    const groups = new Map();
    for (const r of routes) {
      const k = routeGroupKey(r);
      const arr = groups.get(k) || [];
      arr.push(r);
      groups.set(k, arr);
    }

    const seen = new Map();
    for (const [, members] of groups) {
      let best = members[0],
        bestN = trackWayCount(best);
      for (let i = 1; i < members.length; i++) {
        const n = trackWayCount(members[i]);
        if (n > bestN) {
          bestN = n;
          best = members[i];
        }
      }
      const mode = best.tags.route;
      const color = normalizeColorBridge(best.tags.colour || best.tags.color);
      ingestRouteWays(best, mode, color, ways, seen);
    }

    // Stitch ways into continuous chains per (mode, color) bucket.
    const buckets = new Map();
    for (const w of seen.values()) {
      const k = w.mode + "|" + (w.color || "");
      let arr = buckets.get(k);
      if (!arr) {
        arr = [];
        buckets.set(k, arr);
      }
      arr.push(w);
    }

    const features = [];
    for (const [, arr] of buckets) {
      const byEndpoint = new Map();
      const remaining = new Set(arr);
      for (const w of arr) {
        const a = w.nodeIds[0],
          b = w.nodeIds[w.nodeIds.length - 1];
        if (!byEndpoint.has(a)) byEndpoint.set(a, new Set());
        if (!byEndpoint.has(b)) byEndpoint.set(b, new Set());
        byEndpoint.get(a).add(w);
        byEndpoint.get(b).add(w);
      }
      const removeWay = (w) => {
        remaining.delete(w);
        const a = w.nodeIds[0],
          b = w.nodeIds[w.nodeIds.length - 1];
        byEndpoint.get(a)?.delete(w);
        byEndpoint.get(b)?.delete(w);
      };

      while (remaining.size) {
        const start = remaining.values().next().value;
        removeWay(start);
        let chainNodes = [...start.nodeIds];

        let extended = true;
        while (extended) {
          extended = false;
          const tail = chainNodes[chainNodes.length - 1];
          const candidates = byEndpoint.get(tail);
          if (candidates && candidates.size) {
            const nxt = candidates.values().next().value;
            removeWay(nxt);
            const ids = nxt.nodeIds;
            if (ids[0] === tail) chainNodes.push(...ids.slice(1));
            else chainNodes.push(...ids.slice(0, -1).reverse());
            extended = true;
          }
        }
        extended = true;
        while (extended) {
          extended = false;
          const head = chainNodes[0];
          const candidates = byEndpoint.get(head);
          if (candidates && candidates.size) {
            const nxt = candidates.values().next().value;
            removeWay(nxt);
            const ids = nxt.nodeIds;
            if (ids[ids.length - 1] === head)
              chainNodes = [...ids.slice(0, -1), ...chainNodes];
            else chainNodes = [...ids.slice(1).reverse(), ...chainNodes];
            extended = true;
          }
        }

        const path = [];
        for (const nid of chainNodes) {
          const ll = nodes.get(nid);
          if (ll) path.push({ lat: ll[0], lng: ll[1] });
        }
        if (path.length >= 2)
          features.push({ mode: start.mode, color: start.color, path });
      }
    }

    // Simplify and quantize coordinates to ~5 decimals (≈1 m).
    return features.map((f) => {
      const simplified = douglasPeuckerBridge(f.path, SIMPLIFY_DEG);
      const path = simplified.map((p) => ({
        lat: Math.round(p.lat * 1e5) / 1e5,
        lng: Math.round(p.lng * 1e5) / 1e5,
      }));
      return { mode: f.mode, color: f.color, path };
    });
  }

  bridge.buildOverpassQueryForBbox = buildOverpassQueryForBbox;
  bridge.parseOverpassToFeatures = parseOverpassToFeatures;
})();
