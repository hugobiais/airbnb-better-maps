// Shared low-level helpers used across the layer modules: bbox quantization,
// color parsing, polyline simplification, Airbnb-URL → city slug detection,
// and one-time webfont injection.

// Quantize bbox to a ~0.05° grid so panning slightly reuses the cache key.
export function quantizeBbox(s, w, n, e) {
  const q = (x) => Math.round(x * 20) / 20;
  return `${q(s)},${q(w)},${q(n)},${q(e)}`;
}

export function normalizeColor(c) {
  if (!c) return null;
  if (/^#?[0-9a-f]{6}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
  if (/^#?[0-9a-f]{3}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
  // Named colors fall through — Google Maps accepts them.
  return c;
}

export function douglasPeucker(path, eps) {
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
      const d = sqDistToSegment(path[i], a, b);
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

function sqDistToSegment(p, a, b) {
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

// We only inject on Airbnb search-results pages (/s/<city>/homes or /all).
// Listing-detail pages (/rooms/<id>) are intentionally excluded — their map
// is just a small embed and the Layers UI gets in the way. Locale prefixes
// like /fr/... and trailing slashes are tolerated.
export function isMapUrl(pathname = location.pathname) {
  const p = pathname.replace(/^\/[a-z]{2}(?=\/)/, "");
  return /^\/s\/[^/]+\/(homes|all)\b/.test(p);
}

// Airbnb search URLs: /s/<City>--<Country>/homes  or  ?query=<City>,<Country>
export function detectCitySlug() {
  const m = location.pathname.match(/\/s\/([^\/]+)\/(homes|all)/);
  let raw = null;
  if (m) raw = decodeURIComponent(m[1]).split(/--|,/)[0];
  if (!raw) {
    const q = new URLSearchParams(location.search).get("query");
    if (q) raw = q.split(",")[0];
  }
  if (!raw) return null;
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// Inject Nunito 700 once, so tag labels match hoodmaps' typography.
let fontInjected = false;
export function ensureFont() {
  if (fontInjected) return;
  fontInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Nunito:wght@700&display=swap";
  (document.head || document.documentElement).appendChild(link);
}
