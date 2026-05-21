const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const extensionPath = path.resolve(__dirname, "../..");

async function launchExtensionContext(name) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), name + "-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  return { context, userDataDir };
}

async function closeExtensionContext(context, userDataDir) {
  if (context) await context.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
}

module.exports = {
  closeExtensionContext,
  extensionPath,
  launchExtensionContext,
};
