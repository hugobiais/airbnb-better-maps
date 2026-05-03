// Content script: injects page.js into the page's MAIN world and bridges
// chrome.storage <-> postMessage so the popup can toggle the overlay.

const s = document.createElement("script");
s.src = chrome.runtime.getURL("page.js");
s.async = false;
(document.head || document.documentElement).appendChild(s);

const SETTINGS_KEY = "transitOverlay";
const DEFAULTS = { enabled: true, modes: { subway: true, tram: true, light_rail: true, train: true } };

function send(settings) {
  window.postMessage({ source: "abnb-transit-overlay", type: "settings", settings }, "*");
}

chrome.storage.local.get(SETTINGS_KEY).then(({ [SETTINGS_KEY]: saved }) => {
  send({ ...DEFAULTS, ...(saved || {}) });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  send({ ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) });
});
