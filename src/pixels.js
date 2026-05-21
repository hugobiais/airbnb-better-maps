// Hoodmaps pixel layer: cities without categorized district GeoJSON still
// publish crowd-painted cells in the main get_data payload.

import { state } from "./state.js";
import { CATEGORY_COLORS } from "./districts.js";
import {
  ensureHoodmapsData,
  getEffectiveHoodmapsMode,
  getHoodmapsAvailability,
} from "./hoodmaps-data.js";
import { resolveHoodmapsSlug } from "./hoodmaps-resolver.js";

const HIGH_ZOOM = 13;
const LOW_STEP = 0.01;
const HIGH_STEP = 0.001;

let PixelOverlay = null;
function ensurePixelOverlay() {
  if (PixelOverlay || !window.google || !google.maps || !google.maps.OverlayView)
    return;
  PixelOverlay = class extends google.maps.OverlayView {
    constructor(paths, step, settings) {
      super();
      this.paths = paths;
      this.step = step;
      this.settings = settings;
      this.canvas = null;
    }
    onAdd() {
      const canvas = document.createElement("canvas");
      canvas.dataset.abmLayer = "hoodmaps-pixels";
      canvas.style.cssText =
        "position:absolute;pointer-events:none;will-change:transform;";
      this.canvas = canvas;
      this.getPanes().overlayLayer.appendChild(canvas);
    }
    draw() {
      if (!this.canvas) return;
      const map = this.getMap();
      const projection = this.getProjection();
      const bounds = map && map.getBounds && map.getBounds();
      if (!map || !projection || !bounds) return;

      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());
      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
      if (!ne || !sw) return;

      const left = Math.min(sw.x, ne.x);
      const top = Math.min(sw.y, ne.y);
      const width = Math.max(1, Math.abs(ne.x - sw.x));
      const height = Math.max(1, Math.abs(sw.y - ne.y));
      const dpr = window.devicePixelRatio || 1;
      const canvasWidth = Math.ceil(width * dpr);
      const canvasHeight = Math.ceil(height * dpr);

      if (
        this.canvas.width !== canvasWidth ||
        this.canvas.height !== canvasHeight
      ) {
        this.canvas.width = canvasWidth;
        this.canvas.height = canvasHeight;
      }
      this.canvas.style.left = left + "px";
      this.canvas.style.top = top + "px";
      this.canvas.style.width = width + "px";
      this.canvas.style.height = height + "px";

      const ctx = this.canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const center = bounds.getCenter();
      const p0 = projection.fromLatLngToDivPixel(center);
      const p1 = projection.fromLatLngToDivPixel(
        new google.maps.LatLng(
          center.lat() + this.step,
          center.lng() + this.step,
        ),
      );
      if (!p0 || !p1) return;
      const cellW = Math.max(1, Math.abs(p1.x - p0.x) + 0.5);
      const cellH = Math.max(1, Math.abs(p1.y - p0.y) + 0.5);
      const north = bounds.getNorthEast().lat() + this.step;
      const south = bounds.getSouthWest().lat() - this.step;
      const east = bounds.getNorthEast().lng() + this.step;
      const west = bounds.getSouthWest().lng() - this.step;
      const cats = (this.settings && this.settings.categories) || {};
      const maxAlpha = Math.max(
        0,
        Math.min(1, ((this.settings && this.settings.opacity) ?? 35) / 100),
      );
      let drawn = 0;

      for (const path of this.paths) {
        const lat = path[0];
        const lng = path[1];
        if (lat < south || lat > north || lng < west || lng > east) continue;
        const category = path[2];
        if (cats[category] === false) continue;
        const rgb = colorToRgb(CATEGORY_COLORS[category]);
        if (!rgb) continue;
        const point = projection.fromLatLngToDivPixel(
          new google.maps.LatLng(lat, lng),
        );
        if (!point) continue;
        const rawWeight = Number(path[3]);
        const weight = Math.max(
          0,
          Math.min(1, Number.isFinite(rawWeight) ? rawWeight : 0.5),
        );
        const alpha = maxAlpha * (0.35 + weight * 0.65);
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
        ctx.fillRect(
          Math.round(point.x - left - cellW / 2),
          Math.round(point.y - top - cellH / 2),
          Math.ceil(cellW) + 1,
          Math.ceil(cellH) + 1,
        );
        drawn++;
      }
      this.canvas.__abmPixelStats = {
        drawn,
        sourcePoints: this.paths.length,
        step: this.step,
      };
    }
    onRemove() {
      if (this.canvas && this.canvas.parentNode)
        this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = null;
    }
    update(paths, step, settings) {
      this.paths = paths;
      this.step = step;
      this.settings = settings;
      this.draw();
    }
  };
}

export function clearPixelOverlay(entry) {
  if (entry.pixelOverlay) entry.pixelOverlay.setMap(null);
  entry.pixelOverlay = null;
  entry.pixelsSlug = null;
}

export function refreshPixels(map) {
  const entry = state.perMap.get(map);
  if (!entry) return;
  const hm = state.settings.hoodmaps || {};
  if (!state.settings.enabled || !hm.enabled) {
    clearPixelOverlay(entry);
    return;
  }

  const resolved = resolveHoodmapsSlug(map);
  if (entry.pixelsRequestedSlug !== resolved.requestedSlug) {
    clearPixelOverlay(entry);
    entry.pixelsRequestedSlug = resolved.requestedSlug;
  }
  if (!resolved.ready) return;
  const slug = resolved.slug;
  if (entry.pixelsSlug !== slug) clearPixelOverlay(entry);
  entry.pixelsSlug = slug;
  if (!slug) return;

  ensureHoodmapsData(slug);
  const availability = getHoodmapsAvailability(slug);
  if (!availability.known) return;
  if (getEffectiveHoodmapsMode(slug) !== "pixels") {
    clearPixelOverlay(entry);
    return;
  }

  const pixelPaths = state.pixelPathsBySlug.get(slug);
  if (!pixelPaths || (!pixelPaths.low.length && !pixelPaths.high.length)) {
    clearPixelOverlay(entry);
    return;
  }

  const useHigh =
    (map.getZoom() || 0) >= HIGH_ZOOM && pixelPaths.high.length > 0;
  const paths =
    useHigh || !pixelPaths.low.length ? pixelPaths.high : pixelPaths.low;
  const step = useHigh || !pixelPaths.low.length ? HIGH_STEP : LOW_STEP;
  ensurePixelOverlay();
  if (!PixelOverlay) return;
  if (!entry.pixelOverlay) {
    entry.pixelOverlay = new PixelOverlay(paths, step, hm);
    entry.pixelOverlay.setMap(map);
  } else {
    entry.pixelOverlay.update(paths, step, hm);
  }
}

function colorToRgb(color) {
  if (!color) return null;
  const hex = color.replace("#", "");
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length !== 6) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}
