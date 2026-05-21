// Hoodmaps text tags: short crowdsourced labels overlaid on the map. We
// fetch via bridge.js (cached), then place top-N by votes using pixel-space
// AABB collision so wide labels don't overlap their neighbors.

import { state } from "./state.js";
import { ensureFont } from "./utils.js";
import { ensureHoodmapsData } from "./hoodmaps-data.js";
import { resolveHoodmapsSlug } from "./hoodmaps-resolver.js";

const PERF_PREFIX = "[abnb-better-maps:perf]";

let TextOverlay = null;
function ensureTextOverlay() {
  if (TextOverlay || !window.google || !google.maps || !google.maps.OverlayView)
    return;
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
      const maxWidth = this.opts.maxWidth || 0;
      div.style.cssText =
        "position:absolute;transform:translate(-50%,-50%);" +
        "font-family:'Nunito',-apple-system,system-ui,sans-serif;font-weight:700;" +
        "pointer-events:none;letter-spacing:.2px;text-align:center;" +
        "line-height:1.05;color:#fff;" +
        "text-shadow:" +
        "1px 1px 0 #454545,1px 2px 0 #454545,3px 3px 0 #454545," +
        "-1px -1px 0 #454545,1px -1px 0 #454545," +
        "-1px 1px 0 #454545,0px 1px 0 #454545;";
      div.style.fontSize = fs + "px";
      if (maxWidth) {
        div.style.maxWidth = maxWidth + "px";
        div.style.whiteSpace = "normal";
        div.style.wordBreak = "break-word";
      } else {
        // Single-line labels skip max-width so the browser uses the natural
        // width and can't break mid-word if our estimate was a touch tight.
        div.style.whiteSpace = "nowrap";
      }
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
      if (this.div && this.div.parentNode)
        this.div.parentNode.removeChild(this.div);
      this.div = null;
    }
  };
}

export function clearTagOverlays(entry) {
  for (const o of entry.tagOverlays) o.setMap(null);
  entry.tagOverlays = [];
  entry.tagsRenderKey = null;
}

export function refreshTags(map) {
  const startedAt = performance.now();
  const entry = state.perMap.get(map);
  if (!entry) return;
  const hm = state.settings.hoodmaps || {};
  if (!state.settings.enabled || !hm.enabled || !hm.labels) {
    clearTagOverlays(entry);
    return;
  }
  const resolved = resolveHoodmapsSlug(map);
  if (entry.tagsRequestedSlug !== resolved.requestedSlug) {
    clearTagOverlays(entry);
    entry.tagsRequestedSlug = resolved.requestedSlug;
  }
  if (!resolved.ready) return;
  const slug = resolved.slug;
  // Drop stale labels immediately on slug change — otherwise we'd keep
  // the old city's text on screen until the new fetch returns.
  if (entry.tagsSlug !== slug) clearTagOverlays(entry);
  entry.tagsSlug = slug;
  if (!slug) return;
  const tags = state.tagsBySlug.get(slug);
  if (!tags) {
    const wasPending = state.hoodmapsDataPending.has(slug);
    ensureHoodmapsData(slug);
    if (!wasPending && state.hoodmapsDataPending.has(slug)) {
      console.log(PERF_PREFIX, "tags request", {
        slug,
        totalMs: roundMs(performance.now() - startedAt),
      });
    }
    return;
  }
  ensureFont();
  ensureTextOverlay();
  if (!TextOverlay) return;

  const bounds = map.getBounds();
  if (!bounds) return;
  const ne = bounds.getNorthEast(),
    sw = bounds.getSouthWest();
  const inView = tags.filter(
    (t) =>
      t.lat <= ne.lat() &&
      t.lat >= sw.lat() &&
      t.lng <= ne.lng() &&
      t.lng >= sw.lng(),
  );

  // Project lat/lng to pixel space so we can do real bounding-box collision
  // detection. Google's projection returns "world" coords on a 256-tile grid;
  // multiplying by 2^zoom yields screen pixels.
  const proj = map.getProjection();
  if (!proj) return;
  const z = map.getZoom() || 12;
  const scale = Math.pow(2, z);
  const toPx = (lat, lng) => {
    const p = proj.fromLatLngToPoint(new google.maps.LatLng(lat, lng));
    return { x: p.x * scale, y: p.y * scale };
  };

  // Bucket continuous zoom into discrete tiers. All sizing/thresholds/caps
  // depend only on the tier (never on `z` directly), so zooming within a
  // tier produces identical labels and we can short-circuit re-rendering.
  // Tiers: 0=city, 1=district, 2=neighborhood, 3=block, 4=street.
  const tier = z >= 17 ? 4 : z >= 15 ? 3 : z >= 13 ? 2 : z >= 11 ? 1 : 0;

  // Skip work if same tier and bounds haven't moved meaningfully. The pan
  // grid is coarser at lower tiers so small pans don't invalidate either.
  const panQ = [0.1, 0.05, 0.02, 0.01, 0.005][tier];
  const q = (v) => Math.round(v / panQ);
  const renderKey = [
    tier,
    q(sw.lat()),
    q(sw.lng()),
    q(ne.lat()),
    q(ne.lng()),
  ].join(",");
  if (entry.tagsRenderKey === renderKey && entry.tagOverlays.length) return;
  entry.tagsRenderKey = renderKey;

  // Per-tier knobs: vote threshold, font scale, label cap.
  const MIN_VOTES = [20, 12, 6, 3, 2][tier];
  const zScale = [0.6, 0.7, 0.85, 1, 1][tier];
  const MAX = [10, 14, 18, 24, 30][tier];

  const sizeFor = (votes) =>
    Math.max(12, Math.min(44, (12 + votes * 0.1) * zScale));

  const ranked = [...inView]
    .filter((t) => t.votes >= MIN_VOTES)
    .sort((a, b) => b.votes - a.votes);

  const placed = [];
  for (const t of ranked) {
    if (placed.length >= MAX) break;
    const fontSize = sizeFor(t.votes);
    const { w, h, padX, lines } = measure(t.text, fontSize);
    const { x, y } = toPx(t.lat, t.lng);
    const box = { l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
    let collides = false;
    for (const p of placed) {
      if (
        box.l < p.box.r &&
        box.r > p.box.l &&
        box.t < p.box.b &&
        box.b > p.box.t
      ) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    placed.push({
      lat: t.lat,
      lng: t.lng,
      text: t.text,
      fontSize,
      // Only constrain width when we actually need to wrap. Single-line
      // labels render with white-space:nowrap (see TextOverlay.onAdd).
      maxWidth: lines.length > 1 ? w - padX * 2 : 0,
      box,
    });
  }

  clearTagOverlays(entry);
  for (const t of placed) {
    const o = new TextOverlay(new google.maps.LatLng(t.lat, t.lng), t.text, {
      fontSize: t.fontSize,
      maxWidth: t.maxWidth,
    });
    o.setMap(map);
    entry.tagOverlays.push(o);
  }
  console.log(PERF_PREFIX, "tags refresh", {
    slug,
    tier,
    inView: inView.length,
    candidates: ranked.length,
    placed: placed.length,
    totalMs: roundMs(performance.now() - startedAt),
  });
}

// Hoodmaps wraps long labels onto 2-3 lines so they don't bulldoze their
// neighbors. We mirror that with a per-line character cap; "a LOT of
// tourists" (17 chars) stays single-line, longer phrases wrap.
function wrapText(text, fontSize) {
  const charPerLine = Math.round(34 - Math.min(8, fontSize / 5.5));
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
      continue;
    }
    if ((cur + " " + w).length > charPerLine) {
      lines.push(cur);
      cur = w;
    } else {
      cur += " " + w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Approximate rendered bounding box in pixels. Padding scales with font
// size so large tags reserve more breathing room than small ones.
function measure(text, fontSize) {
  const lines = wrapText(text, fontSize);
  const longest = Math.max(...lines.map((l) => l.length));
  const padX = 10 + fontSize * 0.35;
  const padY = 6 + fontSize * 0.2;
  const w = fontSize * 0.55 * longest + padX * 2;
  const h = fontSize * 1.05 * lines.length + padY * 2;
  return { w, h, lines, padX };
}

function roundMs(ms) {
  return Math.round(ms * 10) / 10;
}
