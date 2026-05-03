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
    settings: {
      enabled: true,
      transit: { enabled: true, modes: { subway: true, tram: true, light_rail: true, train: true } },
      hoodmaps: {
        enabled: false, labels: true, opacity: 35,
        categories: { hipsters: true, uni: true, rich: true, suits: true, normies: true, tourists: true, nightlife: true, crime: true },
      },
    },
    maps: new Set(),
    perMap: new WeakMap(),
    cache: new Map(),
    tagsBySlug: new Map(),
    tagsPending: new Set(),
    districtsBySlug: new Map(),
    districtsPending: new Set(),
  };

  function refreshAll(map) { refresh(map); refreshTags(map); refreshDistricts(map); refreshLegend(map); }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "abnb-transit-overlay") return;
    if (e.data.type === "settings") {
      state.settings = e.data.settings;
      for (const m of state.maps) refreshAll(m);
    } else if (e.data.type === "tagsResponse") {
      state.tagsPending.delete(e.data.slug);
      if (e.data.tags) state.tagsBySlug.set(e.data.slug, e.data.tags);
      for (const m of state.maps) refreshTags(m);
    } else if (e.data.type === "districtsResponse") {
      state.districtsPending.delete(e.data.slug);
      if (e.data.geojson) state.districtsBySlug.set(e.data.slug, e.data.geojson);
      for (const m of state.maps) { refreshDistricts(m); refreshLegend(m); }
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
    state.perMap.set(map, {
      polylines: [], lastBboxKey: null, fetching: false,
      tagOverlays: [], tagsSlug: null,
      dataLayer: null, districtsSlug: null,
      legendEl: null,
    });
    map.addListener("idle", () => { refresh(map); refreshTags(map); });
    refreshAll(map);
  }

  async function refresh(map) {
    const entry = state.perMap.get(map);
    if (!entry) return;

    if (!state.settings.enabled || !state.settings.transit || !state.settings.transit.enabled) {
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
    const enabledModes = (state.settings.transit && state.settings.transit.modes) || {};
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

  // -------- Neighborhood tags layer (hoodmaps.com) --------

  let TextOverlay = null;
  function ensureTextOverlay() {
    if (TextOverlay || !window.google || !google.maps || !google.maps.OverlayView) return;
    TextOverlay = class extends google.maps.OverlayView {
      constructor(position, text, opts) {
        super();
        this.position = position;
        this.text = text;
        this.opts = opts || {};
        this.div = null;
      }
      onAdd() {
        const div = document.createElement("div");
        const fs = this.opts.fontSize || 12;
        const color = this.opts.color || "#222";
        div.style.cssText =
          "position:absolute;transform:translate(-50%,-50%);" +
          "font-family:-apple-system,system-ui,sans-serif;font-weight:600;" +
          "white-space:nowrap;pointer-events:none;letter-spacing:.2px;" +
          "text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff,0 1px 2px rgba(0,0,0,.15);";
        div.style.fontSize = fs + "px";
        div.style.color = color;
        div.textContent = this.text;
        this.div = div;
        this.getPanes().floatPane.appendChild(div);
      }
      draw() {
        if (!this.div) return;
        const proj = this.getProjection();
        if (!proj) return;
        const pt = proj.fromLatLngToDivPixel(this.position);
        if (!pt) return;
        this.div.style.left = pt.x + "px";
        this.div.style.top = pt.y + "px";
      }
      onRemove() {
        if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
    };
  }

  function detectCitySlug() {
    // Airbnb search URLs: /s/<City>--<Country>/homes  or  ?query=<City>,%20<Country>
    const m = location.pathname.match(/\/s\/([^\/]+)\/(homes|all)/);
    let raw = null;
    if (m) raw = decodeURIComponent(m[1]).split(/--|,/)[0];
    if (!raw) {
      const q = new URLSearchParams(location.search).get("query");
      if (q) raw = q.split(",")[0];
    }
    if (!raw) return null;
    return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }

  function clearTagOverlays(entry) {
    for (const o of entry.tagOverlays) o.setMap(null);
    entry.tagOverlays = [];
  }

  function refreshTags(map) {
    const entry = state.perMap.get(map);
    if (!entry) return;
    const hm = state.settings.hoodmaps || {};
    if (!state.settings.enabled || !hm.enabled || !hm.labels) {
      clearTagOverlays(entry);
      return;
    }
    const slug = detectCitySlug();
    entry.tagsSlug = slug;
    if (!slug) { clearTagOverlays(entry); return; }
    const tags = state.tagsBySlug.get(slug);
    if (!tags) {
      if (!state.tagsPending.has(slug)) {
        state.tagsPending.add(slug);
        window.postMessage({ source: "abnb-transit-overlay-page", type: "tagsRequest", slug }, "*");
      }
      return;
    }
    ensureTextOverlay();
    if (!TextOverlay) return;

    const bounds = map.getBounds();
    if (!bounds) return;
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    const inView = tags.filter((t) =>
      t.lat <= ne.lat() && t.lat >= sw.lat() && t.lng <= ne.lng() && t.lng >= sw.lng()
    );

    // Dedup near-collocated tags within ~80m grid: keep the one with most votes.
    const GRID = 0.0008;
    const cellBest = new Map();
    for (const t of inView) {
      const k = Math.round(t.lat / GRID) + "," + Math.round(t.lng / GRID);
      const cur = cellBest.get(k);
      if (!cur || t.votes > cur.votes) cellBest.set(k, t);
    }
    const ranked = [...cellBest.values()].sort((a, b) => b.votes - a.votes);

    // Cap at MAX based on zoom: more zoom = more labels.
    const z = map.getZoom() || 12;
    const MAX = z >= 15 ? 80 : z >= 13 ? 50 : 30;
    const top = ranked.slice(0, MAX);

    clearTagOverlays(entry);
    for (const t of top) {
      const fontSize = Math.min(18, Math.max(11, 10 + Math.log2(Math.max(2, t.votes)) * 1.2));
      const color = t.sentiment > 1 ? "#1f7a3a" : t.sentiment < -1 ? "#a8323d" : "#333";
      const o = new TextOverlay(new google.maps.LatLng(t.lat, t.lng), t.text, { fontSize, color });
      o.setMap(map);
      entry.tagOverlays.push(o);
    }
  }

  // -------- Categorized neighborhood zones (hoodmaps districts geojson) --------

  // Hoodmaps' 8 categories, using their own color code (sampled from the
  // hoodmaps.com legend). The geojson per-feature `opacity` is multiplied with
  // our base alpha so denser zones look stronger.
  const CATEGORY_COLORS = {
    hipsters: "#F1C40F", // hoodmaps "Cool" — yellow
    uni: "#1F3A5F",      // dark navy
    rich: "#2ECC71",     // vivid green
    suits: "#5DADE2",    // sky blue
    normies: "#D5DBDB",  // light grey
    tourists: "#E74C3C", // red
    nightlife: "#9B51E0",// purple (not in hoodmaps legend strip — kept)
    crime: "#2C3E50",    // dark grey/near-black
  };

  function refreshDistricts(map) {
    const entry = state.perMap.get(map);
    if (!entry) return;
    const hm = state.settings.hoodmaps || {};
    if (!state.settings.enabled || !hm.enabled) {
      if (entry.dataLayer) { entry.dataLayer.setMap(null); entry.dataLayer = null; entry.districtsSlug = null; }
      return;
    }
    const slug = detectCitySlug();
    if (!slug) return;
    const geojson = state.districtsBySlug.get(slug);
    if (!geojson) {
      if (!state.districtsPending.has(slug)) {
        state.districtsPending.add(slug);
        window.postMessage({ source: "abnb-transit-overlay-page", type: "districtsRequest", slug }, "*");
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

    // Always (re-)apply style so per-category toggles + opacity slider take
    // effect immediately. `hm.opacity` is the user's slider value (0-100); the
    // GeoJSON's per-feature `opacity` is a relative density signal we keep as
    // a multiplier so dense zones still read stronger than sparse ones.
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
        fillColor: color, fillOpacity,
        strokeColor: color, strokeOpacity, strokeWeight: 1,
        clickable: false, zIndex: 0, visible: true,
      };
    });
  }

  // -------- Map legend (bottom-left) --------

  const CATEGORY_LABEL = {
    hipsters: "Hipsters", uni: "University", rich: "Rich", suits: "Suits",
    normies: "Normies", tourists: "Tourists", nightlife: "Nightlife", crime: "Crime",
  };

  function refreshLegend(map) {
    const entry = state.perMap.get(map);
    if (!entry) return;
    const hm = state.settings.hoodmaps || {};
    const show = state.settings.enabled && hm.enabled;
    if (!show) {
      if (entry.legendEl) {
        const arr = map.controls[google.maps.ControlPosition.LEFT_BOTTOM];
        for (let i = arr.getLength() - 1; i >= 0; i--) {
          if (arr.getAt(i) === entry.legendEl) { arr.removeAt(i); break; }
        }
        entry.legendEl = null;
      }
      return;
    }
    if (!entry.legendEl) {
      const el = document.createElement("div");
      el.style.cssText = [
        "background:rgba(255,255,255,0.95)",
        "border-radius:8px",
        "padding:8px 10px",
        "margin:8px",
        "box-shadow:0 1px 4px rgba(0,0,0,0.18)",
        "font:12px -apple-system,system-ui,sans-serif",
        "color:#222",
        "min-width:96px",
      ].join(";");
      map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(el);
      entry.legendEl = el;
    }
    const cats = hm.categories || {};
    // Intersect "user has it enabled" with "the city's GeoJSON actually
    // contains this category". The popup still shows every category, but the
    // map legend only lists what's present locally — Stockholm has no
    // "crime" polygons, no point listing it on the legend.
    const slug = detectCitySlug();
    const geojson = slug ? state.districtsBySlug.get(slug) : null;
    const present = new Set();
    if (geojson && Array.isArray(geojson.features)) {
      for (const f of geojson.features) {
        const c = f && f.properties && f.properties.category;
        if (c) present.add(c);
      }
    }
    while (entry.legendEl.firstChild) entry.legendEl.removeChild(entry.legendEl.firstChild);
    const visible = Object.keys(CATEGORY_LABEL).filter((k) => cats[k] && present.has(k));
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.style.color = "#888";
      empty.textContent = "No zones selected";
      entry.legendEl.appendChild(empty);
      return;
    }
    for (const k of visible) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;line-height:1.6;";
      const sw = document.createElement("span");
      sw.style.cssText = "width:12px;height:12px;border-radius:3px;display:inline-block;background:" + (CATEGORY_COLORS[k] || "#888") + ";";
      const txt = document.createElement("span");
      txt.textContent = CATEGORY_LABEL[k];
      row.appendChild(sw);
      row.appendChild(txt);
      entry.legendEl.appendChild(row);
    }
  }

})();
