// Runs in the page's MAIN world. Hooks google.maps.Map so every map Airbnb
// creates gets a transit overlay sourced from OpenStreetMap via Overpass.

(() => {
  const MODE_FALLBACK_COLORS = {
    subway: "#0066B3",
    tram: "#E60012",
    light_rail: "#8E44AD",
    train: "#2E7D32",
  };

  const state = {
    settings: { enabled: true, modes: { subway: true, tram: true, light_rail: true, train: true } },
    maps: new Set(),
    perMap: new WeakMap(), // map -> { polylines: [], lastBboxKey, fetching }
    cache: new Map(), // tileKey -> GeoJSON-ish features
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "abnb-transit-overlay") return;
    if (e.data.type === "settings") {
      state.settings = e.data.settings;
      for (const m of state.maps) refresh(m);
    }
  });

  // Wait for google.maps.Map to exist, then wrap the constructor so every
  // map instance Airbnb creates is registered.
  // Airbnb often caches `google.maps.Map` before we can wrap it, so the
  // constructor hook alone isn't reliable. We also poll the DOM forever and
  // register any map instance we haven't seen yet.
  let hooked = false;
  setInterval(() => {
    if (!window.google || !window.google.maps || !window.google.maps.Map) return;
    if (!hooked) { hookMapConstructor(); hooked = true; }
    findExistingMaps().forEach(register);
  }, 500);

  function hookMapConstructor() {
    const Orig = google.maps.Map;
    function Wrapped(...args) {
      const m = new Orig(...args);
      register(m);
      return m;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    // Copy static enums (MapTypeId, etc.)
    for (const k of Object.keys(Orig)) {
      try { Wrapped[k] = Orig[k]; } catch {}
    }
    google.maps.Map = Wrapped;
  }

  function findExistingMaps() {
    const found = new Set();
    for (const el of document.querySelectorAll("*")) {
      for (const k of Object.keys(el)) {
        try {
          const v = el[k];
          if (v && v instanceof google.maps.Map) found.add(v);
        } catch {}
      }
    }
    return [...found];
  }

  function register(map) {
    if (state.maps.has(map)) return;
    state.maps.add(map);
    state.perMap.set(map, { polylines: [], lastBboxKey: null, fetching: false });
    map.addListener("idle", () => refresh(map));
    refresh(map);
  }

  async function refresh(map) {
    const entry = state.perMap.get(map);
    if (!entry) return;

    if (!state.settings.enabled) {
      clearPolylines(entry);
      entry.lastFeatures = null;
      entry.lastBboxKey = null;
      return;
    }

    const bounds = map.getBounds();
    if (!bounds) return;
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const bboxKey = quantizeBbox(sw.lat(), sw.lng(), ne.lat(), ne.lng());

    if (entry.fetching) return;

    let features;
    if (entry.lastBboxKey === bboxKey && entry.lastFeatures) {
      // bbox unchanged — just redraw with current mode filter
      features = entry.lastFeatures;
    } else {
      entry.fetching = true;
      try {
        features = await fetchTransit(bboxKey);
        entry.lastBboxKey = bboxKey;
        entry.lastFeatures = features;
      } catch (err) {
        console.warn("[abnb-transit] fetch failed:", err);
        return;
      } finally {
        entry.fetching = false;
      }
    }

    clearPolylines(entry);
    const enabledModes = state.settings.modes || {};
    const MODE_WEIGHT = { subway: 2.5, tram: 2, light_rail: 2, train: 2 };
    const MODE_Z = { train: 1, light_rail: 2, tram: 3, subway: 4 };
    for (const f of features) {
      if (!enabledModes[f.mode]) continue;
      const polyline = new google.maps.Polyline({
        path: f.path,
        strokeColor: f.color || MODE_FALLBACK_COLORS[f.mode] || "#444",
        strokeOpacity: 0.7,
        strokeWeight: MODE_WEIGHT[f.mode] || 2,
        clickable: false,
        zIndex: MODE_Z[f.mode] || 1,
        geodesic: false,
        map,
      });
      entry.polylines.push(polyline);
    }
  }

  function clearPolylines(entry) {
    for (const p of entry.polylines) p.setMap(null);
    entry.polylines = [];
  }

  // Quantize bbox to ~0.05° grid so panning slightly reuses cache.
  function quantizeBbox(s, w, n, e) {
    const q = (x) => Math.round(x * 20) / 20; // 0.05 deg
    const ss = q(s), ww = q(w), nn = q(n), ee = q(e);
    return `${ss},${ww},${nn},${ee}`;
  }

  async function fetchTransit(bboxKey) {
    if (state.cache.has(bboxKey)) return state.cache.get(bboxKey);
    const [s, w, n, e] = bboxKey.split(",").map(Number);
    // Pad slightly so we don't refetch on tiny pans.
    const pad = 0.02;
    const bbox = `${s - pad},${w - pad},${n + pad},${e + pad}`;

    // Fetch route relations in the bbox + their members. route_master would
    // be the "same line, different directions" signal, but in many regions
    // (incl. Stockholm) mappers don't actually create master relations, so
    // bbox queries on route_master return nothing. Instead we infer grouping
    // from tags below (network + ref + colour).
    const query = `
      [out:json][timeout:25];
      (
        relation["type"="route"]["route"~"^(subway|tram|light_rail|train)$"](${bbox});
      );
      out body;
      >;
      out skel qt;
    `;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error("overpass " + res.status);
    const json = await res.json();
    const features = parseOverpass(json);
    state.cache.set(bboxKey, features);
    return features;
  }

  function parseOverpass(json) {
    const VALID = ["subway", "tram", "light_rail", "train"];
    const nodes = new Map();
    const ways = new Map();
    const routes = []; // route relations
    for (const el of json.elements) {
      if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
      else if (el.type === "way") ways.set(el.id, el.nodes);
      else if (el.type === "relation" && el.tags && el.tags.type === "route" &&
               VALID.includes(el.tags.route)) {
        routes.push(el);
      }
    }

    // Group route relations into "virtual masters". For Stockholm and many
    // other cities, OSM mappers don't create explicit route_master relations,
    // but direction-pair routes share `route` + `network` + `ref` + `colour`
    // (only `from`/`to` differ). We group by those tags and pick the variant
    // with the most track-way members per group. That collapses
    // northbound/southbound pairs into a single line drawn once.
    function trackWayCount(rel) {
      let n = 0;
      for (const m of rel.members || []) {
        if (m.type !== "way") continue;
        const role = m.role || "";
        if (role === "" || role === "forward" || role === "backward") n++;
      }
      return n;
    }
    function groupKey(rel) {
      const t = rel.tags;
      const ref = t.ref || "";
      const network = t.network || t.operator || "";
      const color = t.colour || t.color || "";
      // If we have a ref, that's the strongest signal. Without it, fall back
      // to color (rare; mainly for unrefed long-distance trains).
      const ident = ref || color;
      return [t.route, network, ident].join("|");
    }

    const groups = new Map(); // key -> [routes]
    for (const r of routes) {
      const k = groupKey(r);
      const arr = groups.get(k) || [];
      arr.push(r);
      groups.set(k, arr);
    }

    const seen = new Map(); // mode:wayId -> {mode, color, nodeIds}
    function ingest(rel, mode, color) {
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

    for (const [, members] of groups) {
      let best = members[0], bestN = trackWayCount(best);
      for (let i = 1; i < members.length; i++) {
        const n = trackWayCount(members[i]);
        if (n > bestN) { bestN = n; best = members[i]; }
      }
      const mode = best.tags.route;
      const color = normalizeColor(best.tags.colour || best.tags.color);
      ingest(best, mode, color);
    }

    // Stitch: group by (mode, color), build an undirected graph keyed by
    // endpoint nodeId, then greedily chain ways into polylines. Each chain
    // becomes one feature with a continuous coordinate path — Polyline will
    // render the joins with round line-join.
    const buckets = new Map(); // "mode|color" -> [way records]
    for (const w of seen.values()) {
      const k = w.mode + "|" + (w.color || "");
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(w);
    }

    const features = [];
    for (const [k, arr] of buckets) {
      // index ways by endpoint
      const byEndpoint = new Map(); // nodeId -> Set of way records
      const remaining = new Set(arr);
      for (const w of arr) {
        const a = w.nodeIds[0], b = w.nodeIds[w.nodeIds.length - 1];
        if (!byEndpoint.has(a)) byEndpoint.set(a, new Set());
        if (!byEndpoint.has(b)) byEndpoint.set(b, new Set());
        byEndpoint.get(a).add(w);
        byEndpoint.get(b).add(w);
      }
      const removeWay = (w) => {
        remaining.delete(w);
        const a = w.nodeIds[0], b = w.nodeIds[w.nodeIds.length - 1];
        byEndpoint.get(a)?.delete(w);
        byEndpoint.get(b)?.delete(w);
      };

      while (remaining.size) {
        // pick any starting way
        const start = remaining.values().next().value;
        removeWay(start);
        let chainNodes = [...start.nodeIds];

        // extend forward (from end of chain)
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
        // extend backward (from start of chain)
        extended = true;
        while (extended) {
          extended = false;
          const head = chainNodes[0];
          const candidates = byEndpoint.get(head);
          if (candidates && candidates.size) {
            const nxt = candidates.values().next().value;
            removeWay(nxt);
            const ids = nxt.nodeIds;
            if (ids[ids.length - 1] === head) chainNodes = [...ids.slice(0, -1), ...chainNodes];
            else chainNodes = [...ids.slice(1).reverse(), ...chainNodes];
            extended = true;
          }
        }

        const [mode, color] = [start.mode, start.color];
        const path = [];
        for (const nid of chainNodes) {
          const ll = nodes.get(nid);
          if (ll) path.push({ lat: ll[0], lng: ll[1] });
        }
        if (path.length >= 2) features.push({ mode, color, path });
      }
    }

    // Douglas-Peucker simplify each chain (~3m epsilon).
    const SIMPLIFY_DEG = 0.00003;
    return features.map((f) => ({ ...f, path: douglasPeucker(f.path, SIMPLIFY_DEG) }));
  }

  function douglasPeucker(path, eps) {
    if (path.length < 3) return path;
    const sqEps = eps * eps;
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack = [[0, path.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxSq = 0, idx = -1;
      const a = path[s], b = path[e];
      for (let i = s + 1; i < e; i++) {
        const d = sqDistToSegment(path[i], a, b);
        if (d > maxSq) { maxSq = d; idx = i; }
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

  function sqDistToSegment(p, a, b) {
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = p.lng - (a.lng + t * dx);
    const ey = p.lat - (a.lat + t * dy);
    return ex * ex + ey * ey;
  }

  function normalizeColor(c) {
    if (!c) return null;
    if (/^#?[0-9a-f]{6}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
    if (/^#?[0-9a-f]{3}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
    // Named colors fall through to CSS — Google Maps accepts them.
    return c;
  }
})();
