// On-map "Layers" panel: a Shadow-DOM control inserted into the Google
// Map's LEFT_TOP slot. Inputs write through bridge.js (via postMessage),
// which persists to chrome.storage and broadcasts settings back so all
// tabs and maps stay in sync.

import { state, PAGE_SOURCE } from "./state.js";
import { refreshDistricts } from "./districts.js";
import { TEMPLATE } from "./controls-template.js";

export function refreshControls(map) {
  const entry = state.perMap.get(map);
  if (!entry) return;
  if (!state.settings.enabled) {
    if (entry.controlsHost) {
      const arr = map.controls[google.maps.ControlPosition.LEFT_TOP];
      for (let i = arr.getLength() - 1; i >= 0; i--) {
        if (arr.getAt(i) === entry.controlsHost) {
          arr.removeAt(i);
          break;
        }
      }
      entry.controlsHost = null;
      entry.controlsSync = null;
    }
    return;
  }
  if (!entry.controlsHost) {
    const built = buildControls();
    map.controls[google.maps.ControlPosition.LEFT_TOP].push(built.host);
    entry.controlsHost = built.host;
    entry.controlsSync = built.sync;
  }
  if (entry.controlsSync) entry.controlsSync(state.settings, entry);
}

function buildControls() {
  const host = document.createElement("div");
  host.style.pointerEvents = "auto";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = TEMPLATE;

  const $ = (id) => shadow.getElementById(id);
  const pill = $("pill"),
    panel = $("panel");
  const modeInputs = () => shadow.querySelectorAll("input[data-mode]");
  const catInputs = () => shadow.querySelectorAll("input[data-cat]");

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  // Click outside the host (and its shadow) closes the panel.
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (!host.contains(e.target)) panel.hidden = true;
  });

  function buildPatch() {
    return {
      enabled: state.settings.enabled,
      transit: {
        enabled: $("transitEnabled").checked,
        modes: {
          subway: shadow.querySelector('input[data-mode="subway"]').checked,
          tram: shadow.querySelector('input[data-mode="tram"]').checked,
          light_rail: shadow.querySelector('input[data-mode="light_rail"]')
            .checked,
          train: shadow.querySelector('input[data-mode="train"]').checked,
        },
      },
      hoodmaps: {
        enabled: $("hoodmapsEnabled").checked,
        labels: $("hoodmapsLabels").checked,
        opacity: Number($("hoodmapsOpacity").value),
        categories: {
          hipsters: shadow.querySelector('input[data-cat="hipsters"]').checked,
          uni: shadow.querySelector('input[data-cat="uni"]').checked,
          rich: shadow.querySelector('input[data-cat="rich"]').checked,
          suits: shadow.querySelector('input[data-cat="suits"]').checked,
          normies: shadow.querySelector('input[data-cat="normies"]').checked,
          tourists: shadow.querySelector('input[data-cat="tourists"]').checked,
          nightlife: shadow.querySelector('input[data-cat="nightlife"]')
            .checked,
          crime: shadow.querySelector('input[data-cat="crime"]').checked,
        },
      },
    };
  }
  function send() {
    window.postMessage(
      { source: PAGE_SOURCE, type: "updateSettings", settings: buildPatch() },
      "*",
    );
  }
  shadow
    .querySelectorAll('input[type="checkbox"]')
    .forEach((el) => el.addEventListener("change", send));
  // Opacity changes restyle locally on every input event (no debounce, no
  // round-trip through chrome.storage) so dragging feels instantaneous. The
  // persisted write is debounced separately.
  let opTimer = null;
  const scheduleSend = () => {
    clearTimeout(opTimer);
    opTimer = setTimeout(send, 120);
  };
  const applyOpacityLocal = (value) => {
    if (!state.settings.hoodmaps) return;
    state.settings.hoodmaps.opacity = value;
    for (const m of state.maps) refreshDistricts(m);
  };
  $("hoodmapsOpacity").addEventListener("input", () => {
    const v = Number($("hoodmapsOpacity").value);
    $("hoodmapsOpacityVal").value = String(v);
    applyOpacityLocal(v);
    scheduleSend();
  });
  $("hoodmapsOpacityVal").addEventListener("input", () => {
    const raw = parseInt($("hoodmapsOpacityVal").value, 10);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.max(0, Math.min(100, raw));
    $("hoodmapsOpacity").value = String(clamped);
    applyOpacityLocal(clamped);
    scheduleSend();
  });
  $("hoodmapsOpacityVal").addEventListener("blur", () => {
    const raw = parseInt($("hoodmapsOpacityVal").value, 10);
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    $("hoodmapsOpacityVal").value = String(clamped);
    $("hoodmapsOpacity").value = String(clamped);
    applyOpacityLocal(clamped);
    scheduleSend();
  });

  function sync(s, entry) {
    $("transitEnabled").checked = !!s.transit.enabled;
    $("hoodmapsEnabled").checked = !!s.hoodmaps.enabled;
    $("hoodmapsLabels").checked = !!s.hoodmaps.labels;
    $("hoodmapsOpacity").value = String(s.hoodmaps.opacity ?? 35);
    if (document.activeElement !== $("hoodmapsOpacityVal")) {
      $("hoodmapsOpacityVal").value = String(s.hoodmaps.opacity ?? 35);
    }
    for (const el of modeInputs())
      el.checked = !!s.transit.modes[el.dataset.mode];
    for (const el of catInputs())
      el.checked = !!s.hoodmaps.categories[el.dataset.cat];

    const tOn = !!s.transit.enabled,
      hOn = !!s.hoodmaps.enabled;
    $("transitSection").dataset.on = String(tOn);
    $("hoodmapsSection").dataset.on = String(hOn);
    for (const el of modeInputs()) {
      el.disabled = !tOn;
      el.closest(".row").classList.toggle("disabled", !tOn);
    }
    $("hoodmapsLabels").disabled = !hOn;
    $("hoodmapsLabels").closest(".row").classList.toggle("disabled", !hOn);
    $("hoodmapsOpacity").disabled = !hOn;
    $("hoodmapsOpacityVal").disabled = !hOn;
    for (const el of catInputs()) {
      el.disabled = !hOn;
      el.closest(".row").classList.toggle("disabled", !hOn);
    }

    const transitLoading = !!(entry && entry.transitLoading && tOn);
    pill.dataset.loading = String(transitLoading);
    const loadingModes =
      transitLoading && entry && entry.loadingModes ? entry.loadingModes : null;
    for (const el of modeInputs()) {
      const row = el.closest(".row");
      const isLoading = !!(loadingModes && loadingModes.has(el.dataset.mode));
      row.classList.toggle("loading", isLoading);
    }
  }

  return { host, sync };
}
