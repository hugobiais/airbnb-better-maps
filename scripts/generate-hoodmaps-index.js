#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const SITEMAP_URL = "https://hoodmaps.com/sitemap.xml";
const HOME_URL = "https://hoodmaps.com/";
const DATA_URL = "https://hoodmaps.com/?action=get_data&slug=";

const DEFAULT_OUT = "data/hoodmaps-coverage-index.json";
const DEFAULT_CACHE_DIR = ".hoodmaps-cache";
const DEFAULT_TILE_SIZE = 0.05;

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await fs.mkdir(opts.cacheDir, { recursive: true });

  const [sitemapXml, labels] = await Promise.all([
    fetchText(SITEMAP_URL),
    fetchAutocompleteLabels(),
  ]);
  let slugs = parseSitemapSlugs(sitemapXml);
  if (opts.slugs.length) {
    const requested = new Set(opts.slugs);
    slugs = slugs.filter((slug) => requested.has(slug));
    for (const slug of requested) {
      if (!slugs.includes(slug)) slugs.push(slug);
    }
  }
  if (opts.limit) slugs = slugs.slice(0, opts.limit);

  console.log(
    `Fetching ${slugs.length} Hoodmaps dataset${slugs.length === 1 ? "" : "s"}...`,
  );

  const results = [];
  let done = 0;
  await mapLimit(slugs, opts.concurrency, async (slug) => {
    const result = await inspectSlug(slug, labels.get(slug), opts);
    results.push(result);
    done++;
    if (done % opts.progressEvery === 0 || done === slugs.length) {
      console.log(`${done}/${slugs.length} ${slug}`);
    }
  });

  results.sort((a, b) => a.slug.localeCompare(b.slug));
  const index = buildIndex(results, opts);
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, JSON.stringify(index, null, 2) + "\n");

  console.log(
    [
      `Wrote ${opts.out}`,
      `datasets=${Object.keys(index.datasets).length}`,
      `empty=${index.emptySlugs.length}`,
      `errors=${index.errors.length}`,
      `tiles=${Object.keys(index.tiles).length}`,
      `overlapTiles=${index.stats.overlapTiles}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    cacheDir: DEFAULT_CACHE_DIR,
    concurrency: 6,
    limit: 0,
    progressEvery: 25,
    slugs: [],
    tileSize: DEFAULT_TILE_SIZE,
    useCache: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--out") opts.out = next();
    else if (arg === "--cache-dir") opts.cacheDir = next();
    else if (arg === "--concurrency") opts.concurrency = positiveInt(next(), arg);
    else if (arg === "--limit") opts.limit = positiveInt(next(), arg);
    else if (arg === "--progress-every")
      opts.progressEvery = positiveInt(next(), arg);
    else if (arg === "--tile-size") opts.tileSize = positiveNumber(next(), arg);
    else if (arg === "--slug") opts.slugs.push(next());
    else if (arg === "--slugs")
      opts.slugs.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--no-cache") opts.useCache = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  opts.out = path.resolve(opts.out);
  opts.cacheDir = path.resolve(opts.cacheDir);
  return opts;
}

function printHelp() {
  console.log(`Usage: npm run hoodmaps:index -- [options]

Options:
  --out <path>             Output JSON path. Default: ${DEFAULT_OUT}
  --cache-dir <path>       Raw get_data cache dir. Default: ${DEFAULT_CACHE_DIR}
  --slug <slug>            Include one slug. Repeatable.
  --slugs <a,b,c>          Include a comma-separated slug list.
  --limit <n>              Process first n sitemap slugs.
  --concurrency <n>        Concurrent get_data fetches. Default: 6
  --tile-size <degrees>    Coverage tile size. Default: ${DEFAULT_TILE_SIZE}
  --no-cache               Refetch get_data even when cached.
`);
}

async function inspectSlug(slug, label, opts) {
  try {
    const data = await fetchHoodmapsData(slug, opts);
    const normalized = normalizeDataset(slug, label, data, opts.tileSize);
    return { ok: true, ...normalized };
  } catch (err) {
    return {
      ok: false,
      slug,
      label: label || null,
      error: String(err && err.message ? err.message : err),
    };
  }
}

async function fetchHoodmapsData(slug, opts) {
  const cachePath = path.join(opts.cacheDir, `${slug}.json`);
  if (opts.useCache) {
    const cached = await readJson(cachePath);
    if (cached) return cached;
  }

  const data = await fetchJson(DATA_URL + encodeURIComponent(slug));
  await fs.writeFile(cachePath, JSON.stringify(data));
  return data;
}

async function fetchAutocompleteLabels() {
  const labels = new Map();
  try {
    const html = await fetchText(HOME_URL);
    const match = html.match(/var autocompleteCities=(\{.*?\});\n/s);
    if (!match) return labels;
    const obj = JSON.parse(match[1]);
    for (const [slug, label] of Object.entries(obj)) labels.set(slug, label);
  } catch (err) {
    console.warn("Could not fetch Hoodmaps autocomplete labels:", err.message);
  }
  return labels;
}

function normalizeDataset(slug, label, data, tileSize) {
  const tags = normalizeTags(data && data.tags);
  const lowPixels = normalizePaths(data && data.oneDecimalLessAllUsersPaths);
  const highPixels = normalizePaths(data && data.highZoomUsersPaths);
  const pixelPoints = lowPixels.length ? lowPixels : highPixels;
  const coveragePoints = pixelPoints.length ? pixelPoints : tags;

  const tagBbox = bboxForPoints(tags);
  const lowPixelBbox = bboxForPoints(lowPixels);
  const highPixelBbox = bboxForPoints(highPixels);
  const pixelBbox = unionBboxes([lowPixelBbox, highPixelBbox]);
  const coverageBbox = pixelBbox || tagBbox;
  const tiles = tileKeysForPoints(coveragePoints, tileSize);

  return {
    slug,
    label: label || null,
    name: stringOrNull(data && data.cityName),
    center: numberPair(data && data.latitude, data && data.longitude),
    capabilities: {
      tags: tags.length > 0,
      pixels: lowPixels.length > 0 || highPixels.length > 0,
      districts: !!(data && data.neighborhoodsGeoJSONAvailable),
    },
    counts: {
      tags: tags.length,
      lowPixels: lowPixels.length,
      highPixels: highPixels.length,
      coveragePoints: coveragePoints.length,
      tiles: tiles.length,
    },
    bboxes: {
      coverage: coverageBbox,
      tags: tagBbox,
      pixels: pixelBbox,
      lowPixels: lowPixelBbox,
      highPixels: highPixelBbox,
    },
    districtsUrl: stringOrNull(data && data.neighborhoodsGeoJSONURL),
    tiles,
    empty: !coverageBbox,
  };
}

function buildIndex(results, opts) {
  const datasets = {};
  const tiles = {};
  const emptySlugs = [];
  const errors = [];

  for (const result of results) {
    if (!result.ok) {
      errors.push({
        slug: result.slug,
        label: result.label || null,
        error: result.error,
      });
      continue;
    }
    if (result.empty) {
      emptySlugs.push(result.slug);
      continue;
    }

    datasets[result.slug] = {
      label: result.label,
      name: result.name,
      center: result.center,
      centerTile: result.center
        ? tileKey(result.center[0], result.center[1], opts.tileSize)
        : null,
      capabilities: result.capabilities,
      counts: result.counts,
      bboxes: result.bboxes,
      districtsUrl: result.districtsUrl,
    };
    for (const tile of result.tiles) {
      if (!tiles[tile]) tiles[tile] = [];
      tiles[tile].push(result.slug);
    }
  }

  for (const slugs of Object.values(tiles)) slugs.sort();

  const overlapTiles = Object.values(tiles).filter((slugs) => slugs.length > 1);
  const overlapPairs = summarizeOverlapPairs(overlapTiles);
  return {
    generatedAt: new Date().toISOString(),
    source: {
      sitemap: SITEMAP_URL,
      dataEndpoint: DATA_URL + "<slug>",
    },
    tileSize: opts.tileSize,
    stats: {
      slugs: results.length,
      datasets: Object.keys(datasets).length,
      empty: emptySlugs.length,
      errors: errors.length,
      tiles: Object.keys(tiles).length,
      overlapTiles: overlapTiles.length,
      maxDatasetsPerTile: overlapTiles.reduce(
        (max, slugs) => Math.max(max, slugs.length),
        1,
      ),
      overlapPairs: overlapPairs.slice(0, 50),
    },
    datasets,
    tiles,
    emptySlugs,
    errors,
  };
}

function summarizeOverlapPairs(overlapTiles) {
  const pairs = new Map();
  for (const slugs of overlapTiles) {
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const key = `${slugs[i]}|${slugs[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  return [...pairs.entries()]
    .map(([pair, tiles]) => {
      const [a, b] = pair.split("|");
      return { slugs: [a, b], tiles };
    })
    .sort((a, b) => b.tiles - a.tiles);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => {
      if (!tag) return null;
      const lat = Number(tag.latitude);
      const lng = Number(tag.longitude);
      if (!validLatLng(lat, lng)) return null;
      return [lat, lng];
    })
    .filter(Boolean);
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((path) => {
      if (!Array.isArray(path)) return null;
      const lat = Number(path[0]);
      const lng = Number(path[1]);
      const category = typeof path[2] === "string" ? path[2] : "";
      if (!validLatLng(lat, lng) || !category) return null;
      return [lat, lng];
    })
    .filter(Boolean);
}

function validLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function bboxForPoints(points) {
  if (!points.length) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  return [
    roundCoord(south),
    roundCoord(west),
    roundCoord(north),
    roundCoord(east),
  ];
}

function unionBboxes(bboxes) {
  const valid = bboxes.filter(Boolean);
  if (!valid.length) return null;
  return bboxForPoints(valid.flatMap((bbox) => [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[3]],
  ]));
}

function tileKeysForPoints(points, tileSize) {
  const keys = new Set();
  for (const [lat, lng] of points) {
    keys.add(tileKey(lat, lng, tileSize));
  }
  return [...keys].sort(compareTileKeys);
}

function tileKey(lat, lng, tileSize) {
  return `${Math.floor(lat / tileSize)}:${Math.floor(lng / tileSize)}`;
}

function compareTileKeys(a, b) {
  const [aLat, aLng] = a.split(":").map(Number);
  const [bLat, bLng] = b.split(":").map(Number);
  return aLat - bLat || aLng - bLng;
}

function numberPair(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [roundCoord(x), roundCoord(y)];
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function roundCoord(value) {
  return Math.round(value * 1e6) / 1e6;
}

function parseSitemapSlugs(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) =>
    m[1].trim(),
  );
  const slugs = locs
    .map((loc) => {
      const match = loc.match(/^https:\/\/hoodmaps\.com\/(.+)-neighborhood-map$/);
      return match ? match[1] : null;
    })
    .filter(Boolean);
  return [...new Set(slugs)];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function mapLimit(items, concurrency, fn) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be > 0`);
  return n;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be > 0`);
  return n;
}
