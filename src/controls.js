// On-map "Layers" panel: a Shadow-DOM control inserted into the Google
// Map's LEFT_TOP slot. Inputs write through bridge.js (via postMessage),
// which persists to chrome.storage and broadcasts settings back so all
// tabs and maps stay in sync.

import { state, PAGE_SOURCE } from "./state.js";

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
  if (entry.controlsSync) entry.controlsSync(state.settings);
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
  let opTimer = null;
  $("hoodmapsOpacity").addEventListener("input", () => {
    $("hoodmapsOpacityVal").textContent = $("hoodmapsOpacity").value + "%";
    clearTimeout(opTimer);
    opTimer = setTimeout(send, 80);
  });

  function sync(s) {
    $("transitEnabled").checked = !!s.transit.enabled;
    $("hoodmapsEnabled").checked = !!s.hoodmaps.enabled;
    $("hoodmapsLabels").checked = !!s.hoodmaps.labels;
    $("hoodmapsOpacity").value = String(s.hoodmaps.opacity ?? 35);
    $("hoodmapsOpacityVal").textContent = (s.hoodmaps.opacity ?? 35) + "%";
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
    for (const el of catInputs()) {
      el.disabled = !hOn;
      el.closest(".row").classList.toggle("disabled", !hOn);
    }
  }

  return { host, sync };
}

const TEMPLATE = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #1a1a1a; }
    .root { position: relative; margin: 16px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 12px 7px 10px; background: #fff; border-radius: 999px;
      border: 2px solid #ff385c;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
      cursor: pointer; user-select: none; font-size: 12px; font-weight: 600;
    }
    .pill:hover { background: #fafafa; }
    .pill .icon {
      width: 16px; height: 16px; flex: 0 0 auto;
      color: #ff385c;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .pill .icon svg { width: 100%; height: 100%; display: block; }
    .panel {
      position: absolute; top: 100%; left: 0; margin-top: 6px;
      width: 280px; max-height: 70vh; overflow-y: auto;
      background: #fff; border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.08);
      padding: 12px;
    }
    .panel[hidden] { display: none; }

    .section {
      background: #fafafa; border: 1px solid #ececec; border-radius: 10px;
      margin-bottom: 10px; overflow: hidden;
      transition: opacity .15s ease;
    }
    .section:last-child { margin-bottom: 0; }
    .section[data-on="false"] { opacity: .5; }
    .section[data-on="false"] .section-body { display: none; }
    .section-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px;
    }
    .section-head .name { font-weight: 600; font-size: 13px; }
    .section-body { padding: 4px 12px 10px; border-top: 1px solid #ececec; }

    label.row {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 0; font-size: 12.5px; cursor: pointer; user-select: none;
    }
    label.row.disabled { cursor: not-allowed; opacity: .4; }
    label.row input[type="checkbox"] {
      margin: 0; accent-color: #ff385c; width: 14px; height: 14px;
      flex: 0 0 auto;
    }
    .swatch {
      width: 12px; height: 12px; border-radius: 3px;
      flex: 0 0 auto; border: 1px solid rgba(0,0,0,0.06);
    }

    .toggle { position: relative; width: 30px; height: 18px; flex: 0 0 auto; }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle .ts {
      position: absolute; cursor: pointer; inset: 0;
      background: #cfcfcf; border-radius: 999px;
      transition: background .15s;
    }
    .toggle .ts::before {
      content: ""; position: absolute;
      width: 14px; height: 14px; left: 2px; top: 2px;
      background: #fff; border-radius: 50%;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      transition: transform .15s;
    }
    .toggle input:checked + .ts { background: #ff385c; }
    .toggle input:checked + .ts::before { transform: translateX(12px); }
    .toggle input:disabled + .ts { opacity: .45; cursor: not-allowed; }

    .sub-head {
      font-size: 10px; color: #6b6b6b; text-transform: uppercase;
      letter-spacing: 0.06em; margin: 8px 0 2px;
    }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .slider-row {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 0 6px; font-size: 12px;
    }
    .slider-row .lbl { flex: 0 0 auto; }
    .slider-row input[type="range"] { flex: 1; accent-color: #ff385c; cursor: pointer; }
    .slider-row input[type="range"]:disabled { cursor: not-allowed; opacity: .5; }
    .slider-row .val {
      min-width: 32px; text-align: right; font-variant-numeric: tabular-nums;
      color: #6b6b6b; font-size: 11px;
    }
  </style>
  <div class="root">
    <div class="pill" id="pill">
      <span class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2 L22 7 L12 12 L2 7 Z"/>
          <path d="M2 12 L12 17 L22 12"/>
          <path d="M2 17 L12 22 L22 17"/>
        </svg>
      </span>
      <span>Layers</span>
    </div>
    <div class="panel" id="panel" hidden>
      <div class="section" id="transitSection">
        <div class="section-head">
          <span class="name">Transit</span>
          <label class="toggle"><input type="checkbox" id="transitEnabled"><span class="ts"></span></label>
        </div>
        <div class="section-body">
          <label class="row"><input type="checkbox" data-mode="subway"><span class="swatch" style="background:#0066B3"></span>Subway / Metro</label>
          <label class="row"><input type="checkbox" data-mode="tram"><span class="swatch" style="background:#E60012"></span>Tram</label>
          <label class="row"><input type="checkbox" data-mode="light_rail"><span class="swatch" style="background:#8E44AD"></span>Light rail</label>
          <label class="row"><input type="checkbox" data-mode="train"><span class="swatch" style="background:#2E7D32"></span>Commuter rail</label>
        </div>
      </div>
      <div class="section" id="hoodmapsSection">
        <div class="section-head">
          <span class="name">Hoodmaps</span>
          <label class="toggle"><input type="checkbox" id="hoodmapsEnabled"><span class="ts"></span></label>
        </div>
        <div class="section-body">
          <label class="row"><input type="checkbox" id="hoodmapsLabels">Show tags</label>
          <div class="slider-row">
            <span class="lbl">Opacity</span>
            <input type="range" id="hoodmapsOpacity" min="0" max="100" step="1">
            <span class="val" id="hoodmapsOpacityVal">35%</span>
          </div>
          <div class="sub-head">Zone categories</div>
          <div class="grid-2">
            <label class="row"><input type="checkbox" data-cat="hipsters"><span class="swatch" style="background:#ffc924"></span>Hipsters</label>
            <label class="row"><input type="checkbox" data-cat="uni"><span class="swatch" style="background:#1c5182"></span>University</label>
            <label class="row"><input type="checkbox" data-cat="rich"><span class="swatch" style="background:#2BDE73"></span>Rich</label>
            <label class="row"><input type="checkbox" data-cat="suits"><span class="swatch" style="background:#42a5ff"></span>Suits</label>
            <label class="row"><input type="checkbox" data-cat="normies"><span class="swatch" style="background:#ccc"></span>Normies</label>
            <label class="row"><input type="checkbox" data-cat="tourists"><span class="swatch" style="background:#ff4742"></span>Tourists</label>
            <label class="row"><input type="checkbox" data-cat="nightlife"><span class="swatch" style="background:#9B51E0"></span>Nightlife</label>
            <label class="row"><input type="checkbox" data-cat="crime"><span class="swatch" style="background:#444"></span>Crime</label>
          </div>
        </div>
      </div>
    </div>
  </div>
`;
