const KEY = "transitOverlay";
const DEFAULTS = {
  enabled: true,
  transit: {
    enabled: true,
    modes: { subway: true, tram: true, light_rail: true, train: true },
  },
  hoodmaps: {
    enabled: false,
    labels: true,
    opacity: 35,
    categories: {
      hipsters: true,
      uni: true,
      rich: true,
      suits: true,
      normies: true,
      tourists: true,
      nightlife: true,
      crime: true,
    },
  },
};

const $ = (id) => document.getElementById(id);
const masterEl = $("masterEnabled");
const statusEl = $("mapStatus");
const statusTextEl = $("mapStatusText");

async function load() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const s = saved || {};
  return {
    ...DEFAULTS,
    ...s,
    transit: {
      ...DEFAULTS.transit,
      ...(s.transit || {}),
      modes: {
        ...DEFAULTS.transit.modes,
        ...((s.transit && s.transit.modes) || {}),
      },
    },
    hoodmaps: {
      ...DEFAULTS.hoodmaps,
      ...(s.hoodmaps || {}),
      categories: {
        ...DEFAULTS.hoodmaps.categories,
        ...((s.hoodmaps && s.hoodmaps.categories) || {}),
      },
    },
  };
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusTextEl.textContent = text;
}

/** Align with manifest: *.airbnb.com + www.airbnb.<ccTLD> guest sites (HTTPS only). */
function isAirbnbGuestTabUrl(raw) {
  if (!raw || !raw.startsWith("https://")) return false;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "airbnb.com" || host.endsWith(".airbnb.com")) return true;
  return /^www\.airbnb\.[a-z0-9.-]+$/.test(host);
}

async function checkMapStatus() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id || !isAirbnbGuestTabUrl(tab.url || "")) {
      setStatus("idle", "Not on an Airbnb page");
      return;
    }
    setStatus("searching", "Looking for map…");
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        if (!window.google || !window.google.maps || !window.google.maps.Map)
          return "no-api";
        for (const el of document.querySelectorAll("*")) {
          for (const k of Object.keys(el)) {
            try {
              if (el[k] instanceof google.maps.Map) return "found";
            } catch {}
          }
        }
        return "no-instance";
      },
    });
    if (result === "found") setStatus("found", "Map found");
    else if (result === "no-api")
      setStatus("searching", "Waiting for Google Maps to load…");
    else if (result === "no-instance")
      setStatus("searching", "Map not on this view yet");
    else setStatus("error", "Couldn’t check map");
  } catch {
    setStatus("error", "Status unavailable");
  }
}

(async () => {
  const s = await load();
  masterEl.checked = !!s.enabled;
  checkMapStatus();
  const interval = setInterval(checkMapStatus, 1500);
  window.addEventListener("blur", () => clearInterval(interval));

  masterEl.addEventListener("change", async () => {
    const cur = await load();
    cur.enabled = masterEl.checked;
    await save(cur);
  });
})();
