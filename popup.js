const KEY = "transitOverlay";
const DEFAULTS = {
  enabled: true,
  transit: { enabled: true, modes: { subway: true, tram: true, light_rail: true, train: true } },
  hoodmaps: {
    enabled: false, labels: true, opacity: 35,
    categories: { hipsters: true, uni: true, rich: true, suits: true, normies: true, tourists: true, nightlife: true, crime: true },
  },
};

const $ = (id) => document.getElementById(id);
const masterEl = $("masterEnabled");
const transitEnabledEl = $("transitEnabled");
const hoodmapsEnabledEl = $("hoodmapsEnabled");
const hoodmapsLabelsEl = $("hoodmapsLabels");
const hoodmapsOpacityEl = $("hoodmapsOpacity");
const hoodmapsOpacityValueEl = $("hoodmapsOpacityValue");
const transitSection = $("transitSection");
const hoodmapsSection = $("hoodmapsSection");
const modeEls = [...document.querySelectorAll("input[data-mode]")];
const catEls = [...document.querySelectorAll("input[data-cat]")];
const statusEl = $("mapStatus");
const statusTextEl = $("mapStatusText");

function setRowDisabled(input, disabled) {
  input.disabled = disabled;
  const row = input.closest(".row");
  if (row) row.classList.toggle("disabled", disabled);
}

function render(s) {
  masterEl.checked = !!s.enabled;
  transitEnabledEl.checked = !!s.transit.enabled;
  hoodmapsEnabledEl.checked = !!s.hoodmaps.enabled;
  hoodmapsLabelsEl.checked = !!s.hoodmaps.labels;
  hoodmapsOpacityEl.value = String(s.hoodmaps.opacity ?? 35);
  hoodmapsOpacityValueEl.textContent = (s.hoodmaps.opacity ?? 35) + "%";
  for (const el of modeEls) el.checked = !!s.transit.modes[el.dataset.mode];
  for (const el of catEls) el.checked = !!s.hoodmaps.categories[el.dataset.cat];

  const masterOn = !!s.enabled;
  const transitOn = masterOn && !!s.transit.enabled;
  const hoodmapsOn = masterOn && !!s.hoodmaps.enabled;

  transitEnabledEl.disabled = !masterOn;
  hoodmapsEnabledEl.disabled = !masterOn;

  for (const el of modeEls) setRowDisabled(el, !transitOn);
  setRowDisabled(hoodmapsLabelsEl, !hoodmapsOn);
  hoodmapsOpacityEl.disabled = !hoodmapsOn;
  for (const el of catEls) setRowDisabled(el, !hoodmapsOn);

  transitSection.dataset.disabled = String(!transitOn);
  transitSection.dataset.sectionOn = String(transitOn);
  hoodmapsSection.dataset.disabled = String(!hoodmapsOn);
  hoodmapsSection.dataset.sectionOn = String(hoodmapsOn);
}

async function load() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const s = saved || {};
  return {
    ...DEFAULTS,
    ...s,
    transit: {
      ...DEFAULTS.transit,
      ...(s.transit || {}),
      modes: { ...DEFAULTS.transit.modes, ...((s.transit && s.transit.modes) || {}) },
    },
    hoodmaps: {
      ...DEFAULTS.hoodmaps,
      ...(s.hoodmaps || {}),
      categories: { ...DEFAULTS.hoodmaps.categories, ...((s.hoodmaps && s.hoodmaps.categories) || {}) },
    },
  };
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
  render(s);
}

// ---- Map detection status ----
function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusTextEl.textContent = text;
}

async function checkMapStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https:\/\/(www\.)?airbnb\./.test(tab.url || "")) {
      setStatus("idle", "Not on an Airbnb page");
      return;
    }
    setStatus("searching", "Looking for map…");
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        if (!window.google || !window.google.maps || !window.google.maps.Map) return "no-api";
        for (const el of document.querySelectorAll("*")) {
          for (const k of Object.keys(el)) {
            try { if (el[k] instanceof google.maps.Map) return "found"; } catch {}
          }
        }
        return "no-instance";
      },
    });
    if (result === "found") setStatus("found", "Map found");
    else if (result === "no-api") setStatus("searching", "Waiting for Google Maps to load…");
    else if (result === "no-instance") setStatus("searching", "Map not on this view yet");
    else setStatus("error", "Couldn’t check map");
  } catch (err) {
    setStatus("error", "Status unavailable");
  }
}

(async () => {
  render(await load());
  checkMapStatus();
  // Re-check every 1.5s while popup is open so users see "Looking for…" → "Map found".
  const interval = setInterval(checkMapStatus, 1500);
  window.addEventListener("blur", () => clearInterval(interval));

  masterEl.addEventListener("change", async () => {
    const cur = await load();
    cur.enabled = masterEl.checked;
    await save(cur);
  });

  transitEnabledEl.addEventListener("change", async () => {
    const cur = await load();
    cur.transit.enabled = transitEnabledEl.checked;
    await save(cur);
  });

  hoodmapsEnabledEl.addEventListener("change", async () => {
    const cur = await load();
    cur.hoodmaps.enabled = hoodmapsEnabledEl.checked;
    await save(cur);
  });

  hoodmapsLabelsEl.addEventListener("change", async () => {
    const cur = await load();
    cur.hoodmaps.labels = hoodmapsLabelsEl.checked;
    await save(cur);
  });

  // Throttle slider saves so we don't hammer chrome.storage on drag.
  let opacitySaveTimer = null;
  hoodmapsOpacityEl.addEventListener("input", () => {
    const v = Number(hoodmapsOpacityEl.value);
    hoodmapsOpacityValueEl.textContent = v + "%";
    clearTimeout(opacitySaveTimer);
    opacitySaveTimer = setTimeout(async () => {
      const cur = await load();
      cur.hoodmaps.opacity = v;
      await save(cur);
    }, 80);
  });

  for (const el of modeEls) {
    el.addEventListener("change", async () => {
      const cur = await load();
      cur.transit.modes[el.dataset.mode] = el.checked;
      await save(cur);
    });
  }

  for (const el of catEls) {
    el.addEventListener("change", async () => {
      const cur = await load();
      cur.hoodmaps.categories[el.dataset.cat] = el.checked;
      await save(cur);
    });
  }
})();
