export const TEMPLATE = `
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
    .pill .spinner {
      width: 12px; height: 12px; flex: 0 0 auto;
      border: 2px solid rgba(255,56,92,0.18);
      border-top-color: #ff385c; border-radius: 50%;
      display: none; animation: spin .75s linear infinite;
    }
    .pill[data-loading="true"] .spinner { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
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
    label.row .row-spinner {
      width: 11px; height: 11px; flex: 0 0 auto; margin-left: auto;
      border: 2px solid rgba(255,56,92,0.18);
      border-top-color: #ff385c; border-radius: 50%;
      display: none; animation: spin .75s linear infinite;
    }
    label.row.loading .row-spinner { display: inline-block; }
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
    .status-line {
      display: flex; align-items: center; gap: 7px;
      min-height: 22px; padding: 2px 0 6px;
      color: #6b6b6b; font-size: 11.5px;
    }
    .status-line[hidden] { display: none; }
    .status-line span { color: #6b6b6b; }
    .mini-spinner {
      width: 12px; height: 12px; flex: 0 0 auto;
      border: 2px solid rgba(255,56,92,0.18);
      border-top-color: #ff385c; border-radius: 50%;
      animation: spin .75s linear infinite;
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
      display: inline-flex; align-items: baseline; gap: 1px;
      color: #6b6b6b; font-size: 11px;
    }
    .slider-row .val input {
      width: 28px; padding: 2px 4px; font: inherit; font-size: 11px;
      font-variant-numeric: tabular-nums; text-align: right;
      color: #1a1a1a; background: #fff;
      border: 1px solid #e0e0e0; border-radius: 4px;
      -moz-appearance: textfield;
    }
    .slider-row .val input::-webkit-outer-spin-button,
    .slider-row .val input::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .slider-row .val input:focus {
      outline: none; border-color: #ff385c;
    }
    .slider-row .val input:disabled {
      color: #6b6b6b; background: #f5f5f5; cursor: not-allowed;
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
      <span class="spinner" aria-hidden="true"></span>
    </div>
    <div class="panel" id="panel" hidden>
      <div class="section" id="transitSection">
        <div class="section-head">
          <span class="name">Transit</span>
          <label class="toggle"><input type="checkbox" id="transitEnabled"><span class="ts"></span></label>
        </div>
        <div class="section-body">
          <label class="row"><input type="checkbox" data-mode="subway"><span class="swatch" style="background:#0066B3"></span>Subway / Metro<span class="row-spinner" aria-hidden="true"></span></label>
          <label class="row"><input type="checkbox" data-mode="tram"><span class="swatch" style="background:#E60012"></span>Tram<span class="row-spinner" aria-hidden="true"></span></label>
          <label class="row"><input type="checkbox" data-mode="light_rail"><span class="swatch" style="background:#8E44AD"></span>Light rail<span class="row-spinner" aria-hidden="true"></span></label>
          <label class="row"><input type="checkbox" data-mode="train"><span class="swatch" style="background:#2E7D32"></span>Commuter rail<span class="row-spinner" aria-hidden="true"></span></label>
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
            <span class="val">
              <input type="number" id="hoodmapsOpacityVal" min="0" max="100" step="1" inputmode="numeric">%
            </span>
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
