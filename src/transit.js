// Transit lines layer: fetches OSM route relations from Overpass for the
// current bbox, stitches direction-pair routes into single polylines, and
// renders via google.maps.Polyline.

import { state } from "./state.js";
import { quantizeBbox, normalizeColor, douglasPeucker } from "./utils.js";

// Fallbacks when OSM has no `colour` tag for a route.
const MODE_FALLBACK_COLORS = {
  subway: "#0066B3",
  tram: "#E60012",
  light_rail: "#8E44AD",
  train: "#2E7D32",
};
const MODE_WEIGHT = { subway: 2.5, tram: 2, light_rail: 2, train: 2 };
const MODE_Z = { train: 1, light_rail: 2, tram: 3, subway: 4 };

export async function refreshTransit(map) {
  const entry = state.perMap.get(map);
  if (!entry) return;

  if (
    !state.settings.enabled ||
    !state.settings.transit ||
    !state.settings.transit.enabled
  ) {
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
    // bbox unchanged — just redraw with the current mode filter.
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
  const enabledModes =
    (state.settings.transit && state.settings.transit.modes) || {};
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

async function fetchTransit(bboxKey) {
  if (state.cache.has(bboxKey)) return state.cache.get(bboxKey);
  const [s, w, n, e] = bboxKey.split(",").map(Number);
  // Pad slightly so we don't refetch on tiny pans.
  const pad = 0.02;
  const bbox = `${s - pad},${w - pad},${n + pad},${e + pad}`;

  // We deliberately query `route` (not `route_master`): in many regions
  // (e.g. Stockholm) mappers don't create master relations, so master
  // bbox queries return nothing. Direction-pair routes get collapsed
  // below by grouping on route + network + ref + colour.
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
  const routes = [];
  for (const el of json.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === "way") ways.set(el.id, el.nodes);
    else if (
      el.type === "relation" &&
      el.tags &&
      el.tags.type === "route" &&
      VALID.includes(el.tags.route)
    ) {
      routes.push(el);
    }
  }

  // Collapse direction-pair routes (same line, different `from`/`to`) by
  // grouping on route+network+ref+colour and keeping the variant with the
  // most track-way members.
  const groups = new Map();
  for (const r of routes) {
    const k = groupKey(r);
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
    const color = normalizeColor(best.tags.colour || best.tags.color);
    ingest(best, mode, color, ways, seen);
  }

  // Stitch ways into continuous chains per (mode, color) bucket so each
  // line renders as one Polyline with proper round joins.
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

      // Extend forward (from end of chain).
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
      // Extend backward (from start of chain).
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

  // Simplify each chain (~3m epsilon).
  const SIMPLIFY_DEG = 0.00003;
  return features.map((f) => ({
    ...f,
    path: douglasPeucker(f.path, SIMPLIFY_DEG),
  }));
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

function groupKey(rel) {
  const t = rel.tags;
  const ref = t.ref || "";
  const network = t.network || t.operator || "";
  const color = t.colour || t.color || "";
  // ref is the strongest signal; fall back to color for unrefed long-distance trains.
  const ident = ref || color;
  return [t.route, network, ident].join("|");
}

function ingest(rel, mode, color, ways, seen) {
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
