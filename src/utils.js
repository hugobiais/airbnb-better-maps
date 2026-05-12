// Shared low-level helpers used across the layer modules: bbox quantization,
// Airbnb-URL → city slug detection, and one-time webfont injection.

// Quantize bbox to a ~0.05° grid so panning slightly reuses the cache key.
export function quantizeBbox(s, w, n, e) {
  const q = (x) => Math.round(x * 20) / 20;
  return `${q(s)},${q(w)},${q(n)},${q(e)}`;
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
