const { test, expect } = require("@playwright/test");
const matrix = require("./hoodmaps-city-matrix.json");
const {
  closeExtensionContext,
  launchExtensionContext,
} = require("../support/extension-context");

const selectedSlugs = new Set(
  (process.env.AIRBNB_MATRIX_SLUGS || "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean),
);
const cities = matrix.cities.filter(
  (city) => !selectedSlugs.size || selectedSlugs.has(city.slug),
);

test.setTimeout(180000);

for (const city of cities) {
  test(`live Airbnb overlays: ${city.name}`, async ({}, testInfo) => {
    const { context, userDataDir } = await launchExtensionContext(
      "airbnb-better-maps-live",
    );
    const consoleMessages = [];

    try {
      // Hoodmaps and Airbnb stay live, but transit is intentionally fake.
      // The fixture proves polyline rendering without depending on Overpass
      // uptime or city-specific OSM route coverage.
      await context.route(
        "https://overpass-api.de/api/interpreter",
        fulfillOverpassTransitFixture,
      );

      const page = context.pages()[0] || (await context.newPage());
      page.on("console", (msg) => {
        consoleMessages.push(`${msg.type()}: ${msg.text()}`);
      });

      const response = await page.goto(city.airbnbUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      expect(response, "Airbnb should return a document response").toBeTruthy();
      expect(
        response.status(),
        `Airbnb returned HTTP ${response.status()}`,
      ).toBeLessThan(400);

      await page.waitForTimeout(8000);
      const gate = await detectGate(page);
      if (gate.detected) {
        await attachDiagnostics(testInfo, page, consoleMessages, city, "airbnb-gate");
        throw new Error(`Airbnb appears gated or captcha-blocked: ${gate.reason}`);
      }

      await maybeAcceptCookies(page);
      await expect(page.locator(".gm-style").first(), "Google Maps is visible")
        .toBeVisible({ timeout: 60000 });
      await waitForPageModule(page);
      await waitForLayersRoot(page);
      await zoomIntoTransitFetchRange(page, city);
      await enableAllLayers(page, city);
      await nudgeMap(page, city);

      const hoodmapsSnapshot = await waitForSnapshot(
        page,
        city,
        (snapshot) =>
          snapshot.hoodmaps.known && !snapshot.hoodmaps.pending,
        "Hoodmaps data to load",
        45000,
      );
      expectResolvedHoodmaps(city, hoodmapsSnapshot);
      expectHoodmapsCapabilities(city, hoodmapsSnapshot);

      await assertRenderedHoodmapsOverlay(page, city);
      await assertRenderedTransitLines(page, city);

      const fatalConsoleMessages = consoleMessages.filter((line) =>
        /\b(abnb-better-maps|abnb-transit|chrome-extension:\/\/)/i.test(line) &&
        /\b(error|failed|uncaught|exception)\b/i.test(line),
      );
      expect(fatalConsoleMessages, "extension console errors").toEqual([]);
    } catch (err) {
      const page = context.pages()[0];
      if (page) await attachDiagnostics(testInfo, page, consoleMessages, city);
      throw err;
    } finally {
      await closeExtensionContext(context, userDataDir);
    }
  });
}

async function waitForPageModule(page) {
  await page.waitForFunction(
    () =>
      [...document.scripts].some((script) =>
        /^chrome-extension:\/\/.+\/page\.js$/.test(script.src),
      ),
    undefined,
    { timeout: 30000 },
  );
}

async function waitForLayersRoot(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("*")].some((el) => {
        const pill = el.shadowRoot && el.shadowRoot.getElementById("pill");
        if (!pill) return false;
        const rect = pill.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    undefined,
    { timeout: 60000 },
  );
}

async function zoomIntoTransitFetchRange(page, city) {
  await page.evaluate(async ({ slug, mapCenter }) => {
    async function importStateModule() {
      const script = [...document.scripts].find((s) =>
        /^chrome-extension:\/\/.+\/page\.js$/.test(s.src),
      );
      if (!script) throw new Error("page.js script not found");
      return import(script.src.replace(/\/page\.js$/, "/src/state.js"));
    }

    const { state } = await importStateModule();
    const map = [...state.maps][0];
    if (!map) throw new Error(`No registered map for ${slug}`);
    if (Array.isArray(mapCenter)) {
      map.setCenter(
        new google.maps.LatLng(
          mapCenter[0],
          mapCenter[1],
        ),
      );
    }
    if ((map.getZoom && map.getZoom()) < 13) map.setZoom(13);
  }, city);
  await waitForSnapshot(
    page,
    city,
    (snapshot) =>
      snapshot.entries.some(
        (entry) =>
          entry.bounds &&
          entry.bounds.latSpan <= 1 &&
          entry.bounds.lngSpan <= 1,
      ),
    "map viewport to enter transit fetch range",
    15000,
  );
}

async function enableAllLayers(page, city) {
  const hoodmapsMode =
    city.expectedHoodmaps === "pixels" ? "pixels" : "districts";
  await page.evaluate((mode) => {
    window.postMessage(
      {
        source: "abnb-transit-overlay-page",
        type: "updateSettings",
        settings: {
          enabled: true,
          transit: {
            enabled: true,
            modes: {
              subway: true,
              tram: false,
              light_rail: false,
              train: false,
            },
          },
          hoodmaps: {
            enabled: true,
            mode,
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
        },
      },
      "*",
    );
  }, hoodmapsMode);
  await waitForSnapshot(
    page,
    city,
    (snapshot) =>
      snapshot.settings.enabled &&
      snapshot.settings.hoodmaps &&
      snapshot.settings.hoodmaps.enabled &&
      snapshot.settings.transit &&
      snapshot.settings.transit.enabled &&
      snapshot.settings.transit.modes &&
      snapshot.settings.transit.modes.subway,
    "extension settings to apply",
    15000,
  );
}

async function nudgeMap(page, city) {
  await page.evaluate(async ({ slug }) => {
    async function importStateModule() {
      const script = [...document.scripts].find((s) =>
        /^chrome-extension:\/\/.+\/page\.js$/.test(s.src),
      );
      if (!script) throw new Error("page.js script not found");
      return import(script.src.replace(/\/page\.js$/, "/src/state.js"));
    }

    const { state } = await importStateModule();
    const map = [...state.maps][0];
    if (!map) throw new Error(`No registered map for ${slug}`);
    const zoom = map.getZoom && map.getZoom();
    if (!zoom) return;
    map.setZoom(zoom >= 20 ? zoom - 1 : zoom + 1);
  }, city);
}

async function assertRenderedHoodmapsOverlay(page, city) {
  if (city.expectedHoodmaps === "both") {
    await waitForSnapshot(
      page,
      city,
      (snapshot) =>
        snapshot.entries.some(
          (entry) =>
            entry.districtLayerAttached &&
            entry.dataLayerFeatures > 0 &&
            entry.districtsSlug === hoodmapsDataSlug(city),
        ),
      "Hoodmaps district polygons to attach to the map",
      45000,
    );
    return;
  }

  if (city.expectedHoodmaps === "pixels") {
    await waitForSnapshot(
      page,
      city,
      (snapshot) =>
        snapshot.entries.some(
          (entry) =>
            entry.pixelOverlayAttached &&
            entry.pixelStats &&
            entry.pixelStats.drawn > 0 &&
            entry.pixelsSlug === hoodmapsDataSlug(city),
        ),
      "Hoodmaps pixel overlay to draw on the map",
      45000,
    );
    return;
  }

  const snapshot = await readAbmSnapshot(page, city);
  expect(
    snapshot.entries.some(
      (entry) => entry.districtLayerAttached || entry.pixelOverlayAttached,
    ),
    "cities without Hoodmaps colors should not render color overlays",
  ).toBe(false);
}

async function assertRenderedTransitLines(page, city) {
  await waitForSnapshot(
    page,
    city,
    (snapshot) =>
      snapshot.entries.some(
        (entry) =>
          entry.lastFeatures > 0 &&
          !entry.fetching &&
          !entry.transitLoading &&
          entry.polylines > 0 &&
          entry.polylinesOnMap > 0,
      ),
    "transit lines to attach to the map",
    90000,
  );
}

async function waitForSnapshot(page, city, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readAbmSnapshot(page, city).catch((err) => ({
      error: String(err),
    }));
    if (predicate(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `${label} timed out for ${city.name}. Last snapshot: ${JSON.stringify(
      last,
      null,
      2,
    )}`,
  );
}

async function readAbmSnapshot(page, city) {
  return page.evaluate(async ({ expectedSlug }) => {
    async function importExtensionModule(path) {
      const script = [...document.scripts].find((s) =>
        /^chrome-extension:\/\/.+\/page\.js$/.test(s.src),
      );
      if (!script) throw new Error("page.js script not found");
      return import(script.src.replace(/\/page\.js$/, path));
    }

    function detectCitySlugForTest() {
      const m = location.pathname.match(/\/s\/([^\/]+)\/(homes|all)/);
      let raw = null;
      if (m) raw = decodeURIComponent(m[1]).split(/--|,/)[0];
      if (!raw) {
        const q = new URLSearchParams(location.search).get("query");
        if (q) raw = q.split(",")[0];
      }
      if (!raw) return null;
      return raw
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
    }

    function normalizedLngSpan(bounds) {
      let span = bounds.getNorthEast().lng() - bounds.getSouthWest().lng();
      if (span < 0) span += 360;
      return span;
    }

    const { state } = await importExtensionModule("/src/state.js");
    const {
      getHoodmapsIndexStatus,
      resolveHoodmapsSlug,
    } = await importExtensionModule("/src/hoodmaps-resolver.js");
    const maps = [...state.maps];
    const resolvedHoodmaps = maps[0]
      ? resolveHoodmapsSlug(maps[0])
      : {
          ready: false,
          requestedSlug: detectCitySlugForTest(),
          slug: null,
          reason: "no-registered-map",
          candidates: [],
        };
    const entries = maps.map((map) => {
      const entry = state.perMap.get(map) || {};
      const bounds = map.getBounds && map.getBounds();
      let dataLayerFeatures = 0;
      if (entry.dataLayer) entry.dataLayer.forEach(() => dataLayerFeatures++);
      let pixelStats = null;
      if (entry.pixelOverlay && entry.pixelOverlay.canvas) {
        pixelStats = entry.pixelOverlay.canvas.__abmPixelStats || null;
      }
      const polylines = Array.isArray(entry.polylines) ? entry.polylines : [];
      return {
        polylines: polylines.length,
        polylinesOnMap: polylines.filter(
          (polyline) => polyline.getMap && polyline.getMap() === map,
        ).length,
        lastFeatures: Array.isArray(entry.lastFeatures)
          ? entry.lastFeatures.length
          : null,
        fetching: !!entry.fetching,
        transitLoading: !!entry.transitLoading,
        loadingModes: entry.loadingModes ? [...entry.loadingModes] : [],
        dataLayerFeatures,
        districtLayerAttached:
          !!entry.dataLayer &&
          entry.dataLayer.getMap &&
          entry.dataLayer.getMap() === map,
        districtsSlug: entry.districtsSlug || null,
        tagOverlays: entry.tagOverlays ? entry.tagOverlays.length : 0,
        tagsSlug: entry.tagsSlug || null,
        pixelStats,
        pixelOverlayAttached:
          !!entry.pixelOverlay &&
          entry.pixelOverlay.getMap &&
          entry.pixelOverlay.getMap() === map,
        pixelsSlug: entry.pixelsSlug || null,
        bounds: bounds
          ? {
              latSpan:
                bounds.getNorthEast().lat() - bounds.getSouthWest().lat(),
              lngSpan: normalizedLngSpan(bounds),
            }
          : null,
      };
    });
    const caps = state.hoodmapsCapabilitiesBySlug.get(expectedSlug) || null;
    const pixels = state.pixelPathsBySlug.get(expectedSlug) || null;
    const tags = state.tagsBySlug.get(expectedSlug) || null;
    return {
      detectedSlug: detectCitySlugForTest(),
      resolvedHoodmaps,
      hoodmapsIndex: getHoodmapsIndexStatus(),
      settings: state.settings,
      maps: maps.length,
      entries,
      hoodmaps: {
        pending: state.hoodmapsDataPending.has(expectedSlug),
        known: state.hoodmapsCapabilitiesBySlug.has(expectedSlug),
        caps,
        tags: Array.isArray(tags) ? tags.length : null,
        lowPixels: pixels && Array.isArray(pixels.low) ? pixels.low.length : null,
        highPixels:
          pixels && Array.isArray(pixels.high) ? pixels.high.length : null,
        districtsLoaded: state.districtsBySlug.has(expectedSlug),
        districtsPending: state.districtsPending.has(expectedSlug),
      },
      transitPending: state.transitPending.size,
      transitRequests: state.transitRequests.size,
    };
  }, { expectedSlug: hoodmapsDataSlug(city) });
}

function expectHoodmapsCapabilities(city, snapshot) {
  const caps = snapshot.hoodmaps.caps || {};
  if (city.expectedHoodmaps === "both") {
    expect(caps.districts, "districts should be available").toBe(true);
    expect(caps.pixels, "pixels should be available").toBe(true);
    expect(snapshot.hoodmaps.tags).toBeGreaterThan(0);
    expect(snapshot.hoodmaps.lowPixels).toBeGreaterThan(0);
    expect(snapshot.hoodmaps.highPixels).toBeGreaterThan(0);
  } else if (city.expectedHoodmaps === "pixels") {
    expect(caps.districts, "districts should not be available").toBe(false);
    expect(caps.pixels, "pixels should be available").toBe(true);
    expect(snapshot.hoodmaps.tags).toBeGreaterThan(0);
    expect(snapshot.hoodmaps.lowPixels).toBeGreaterThan(0);
    expect(snapshot.hoodmaps.highPixels).toBeGreaterThan(0);
  } else {
    expect(!!caps.districts, "districts should not be available").toBe(false);
    expect(!!caps.pixels, "pixels should not be available").toBe(false);
    expect(snapshot.hoodmaps.tags || 0).toBe(0);
    expect(snapshot.hoodmaps.lowPixels || 0).toBe(0);
    expect(snapshot.hoodmaps.highPixels || 0).toBe(0);
  }
}

function expectResolvedHoodmaps(city, snapshot) {
  expect(snapshot.detectedSlug).toBe(city.slug);
  expect(snapshot.resolvedHoodmaps.requestedSlug).toBe(city.slug);
  expect(snapshot.resolvedHoodmaps.slug).toBe(hoodmapsDataSlug(city));
  for (const slug of city.expectedCandidateSlugs || []) {
    expect(
      snapshot.resolvedHoodmaps.candidates.some(
        (candidate) => candidate.slug === slug,
      ),
      `expected Hoodmaps resolver candidates to include ${slug}`,
    ).toBe(true);
  }
}

function hoodmapsDataSlug(city) {
  return city.expectedResolvedSlug || city.slug;
}

async function fulfillOverpassTransitFixture(route) {
  const bbox = parseOverpassBbox(route.request().postData() || "");
  if (!bbox) {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ elements: [] }),
    });
    return;
  }
  const { relation, ways, nodes } = syntheticTransitGrid(bbox);
  // This is not real transit geometry.
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      elements: [relation, ...ways, ...nodes],
    }),
  });
}

function syntheticTransitGrid(bbox) {
  const tileSize = 0.05;
  const tyStart = Math.floor(bbox.s / tileSize);
  const tyEnd = Math.ceil(bbox.n / tileSize) - 1;
  const ways = [];
  const nodes = [];
  const members = [];
  let nodeId = 1000;
  let wayId = 100;
  for (let ty = tyStart; ty <= tyEnd; ty++) {
    const rawLat = (ty + 0.5) * tileSize;
    const lat = Math.max(bbox.s + 0.001, Math.min(bbox.n - 0.001, rawLat));
    const west = bbox.w + 0.001;
    const east = bbox.e - 0.001;
    const mid = (west + east) / 2;
    const ids = [nodeId++, nodeId++, nodeId++];
    nodes.push(
      { type: "node", id: ids[0], lat, lon: west },
      { type: "node", id: ids[1], lat, lon: mid },
      { type: "node", id: ids[2], lat, lon: east },
    );
    ways.push({ type: "way", id: wayId, nodes: ids });
    members.push({ type: "way", ref: wayId, role: "" });
    wayId++;
  }
  return {
    relation: {
      type: "relation",
      id: 1,
      tags: {
        type: "route",
        route: "subway",
        ref: "T",
        colour: "#0066B3",
      },
      members,
    },
    ways,
    nodes,
  };
}

function parseOverpassBbox(body) {
  const data = new URLSearchParams(body).get("data") || body;
  const m = data.match(
    /\[bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/,
  );
  if (!m) return null;
  const [s, w, n, e] = m.slice(1).map(Number);
  if (![s, w, n, e].every(Number.isFinite)) return null;
  return { s, w, n, e };
}

async function detectGate(page) {
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 5000 })
    .catch(() => "");
  const title = await page.title().catch(() => "");
  const url = page.url();
  const text = `${title}\n${url}\n${bodyText}`.toLowerCase();

  const checks = [
    ["captcha", /captcha|recaptcha|hcaptcha/],
    ["human verification", /confirm you're human|verify you are human|are you a human/],
    ["bot or automation challenge", /robot|bot detection|automated access|unusual traffic/],
    ["access denial", /access denied|forbidden|blocked|temporarily unavailable/],
    ["security challenge", /security check|challenge|checking your browser/],
  ];

  for (const [reason, pattern] of checks) {
    if (pattern.test(text)) return { detected: true, reason };
  }
  return { detected: false, reason: null };
}

async function maybeAcceptCookies(page) {
  const labels = [
    "Accept all",
    "Accept",
    "OK",
    "Got it",
    "I agree",
    "Only necessary",
  ];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click().catch(() => {});
    return;
  }
}

async function attachDiagnostics(testInfo, page, consoleMessages, city, suffix = "failure") {
  const screenshot = await page.screenshot({
    fullPage: true,
  }).catch(() => null);
  if (screenshot) {
    await testInfo.attach(`${city.slug}-${suffix}-screenshot`, {
      body: screenshot,
      contentType: "image/png",
    });
  }
  await testInfo.attach(`${city.slug}-${suffix}-console`, {
    body: consoleMessages.join("\n") || "(no console messages captured)",
    contentType: "text/plain",
  });
  await testInfo.attach(`${city.slug}-${suffix}-url`, {
    body: page.url(),
    contentType: "text/plain",
  });
  const snapshot = await readAbmSnapshot(page, city).catch((err) => ({
    error: String(err),
  }));
  await testInfo.attach(`${city.slug}-${suffix}-snapshot`, {
    body: JSON.stringify(snapshot, null, 2),
    contentType: "application/json",
  });
}
