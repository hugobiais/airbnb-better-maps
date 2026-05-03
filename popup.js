const KEY = "transitOverlay";
const DEFAULTS = { enabled: true, modes: { subway: true, tram: true, light_rail: true, train: true } };

const enabledEl = document.getElementById("enabled");
const modeEls = [...document.querySelectorAll("input[data-mode]")];

function render(s) {
  enabledEl.checked = !!s.enabled;
  for (const el of modeEls) el.checked = !!s.modes[el.dataset.mode];
}

async function load() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(saved || {}), modes: { ...DEFAULTS.modes, ...((saved || {}).modes || {}) } };
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
}

(async () => {
  const s = await load();
  render(s);

  enabledEl.addEventListener("change", async () => {
    const cur = await load();
    cur.enabled = enabledEl.checked;
    await save(cur);
  });

  for (const el of modeEls) {
    el.addEventListener("change", async () => {
      const cur = await load();
      cur.modes[el.dataset.mode] = el.checked;
      await save(cur);
    });
  }
})();
