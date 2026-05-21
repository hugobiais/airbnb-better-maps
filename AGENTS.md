# AGENTS.md

Onboarding for any AI coding agent (or human) landing in this repo. Read
this before making non-trivial changes — the architecture has a few
non-obvious moving parts and several past bugs are encoded as deliberate
design choices.

## What this is

Chrome MV3 extension that overlays transit lines + Hoodmaps neighborhood
data on Airbnb's Google Maps view. No build step. Pure JS, ES modules.

## Architecture

Three execution contexts, each in its own JS realm:

```
┌────────────────────────────┐    ┌────────────────────────────┐
│  popup.html / popup.js     │    │  Airbnb tab                │
│  (extension popup window)  │    │                            │
│                            │    │  ┌──────────────────────┐  │
│  master on/off toggle      │    │  │ bridge.js            │  │
│  map-detected status pill  │    │  │ (content script,     │  │
│                            │    │  │  ISOLATED world)     │  │
│  reads/writes              │    │  │                      │  │
│  chrome.storage.local      │    │  │ owns chrome.storage  │  │
└────────────────────────────┘    │  │ owns cross-origin    │  │
            │                     │  │   fetches            │  │
            │ chrome.storage      │  │ injects page.js      │  │
            │ onChanged           │  │   as ES module       │  │
            ▼                     │  └──────────┬───────────┘  │
   ┌────────────────────┐         │             │ window.postMessage
   │  chrome.storage    │◄────────┤             ▼              │
   │  .local            │         │  ┌──────────────────────┐  │
   │                    │         │  │ page.js + src/*.js   │  │
   │  key: transit-     │         │  │ (MAIN world,         │  │
   │       Overlay      │         │  │  ES module graph)    │  │
   │  hoodmaps cache    │         │  │                      │  │
   │  districts cache   │         │  │ hooks google.maps.Map│  │
   └────────────────────┘         │  │ draws all overlays   │  │
                                  │  └──────────────────────┘  │
                                  └────────────────────────────┘
```

### Why three contexts

- **MAIN world** is required to see `window.google.maps`. Content scripts
  run in an isolated world that can't reach the page's `google` global.
- **ISOLATED world** (`bridge.js` + `bridge/*.js`) is required for `chrome.storage` and
  to perform fetches that bypass the page's CSP (Overpass, Hoodmaps).
- **Popup** is a separate document; it talks to storage directly and
  uses `chrome.scripting.executeScript` to probe whether a map exists.

### Message protocol

`page.js` ↔ `bridge.js` over `window.postMessage` (same window, JS realm
boundary). Two source tags:

- `"abnb-transit-overlay-page"` — page.js → bridge.js (requests, writes)
- `"abnb-transit-overlay"` — bridge.js → page.js (settings broadcast,
  fetch responses)

Message types: `requestSettings`, `updateSettings`, `settings`,
`transitRequest`/`transitResponse`, `hoodmapsDataRequest`/`hoodmapsDataResponse`,
`tagsRequest`/`tagsResponse`,
`districtsRequest`/`districtsResponse`.

## File map

| File                     | World              | Responsibility                                                                                                                                                                                               |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json`          | —                  | MV3 config. Host permissions for every Airbnb TLD. Exposes `page.js`, `src/*.js`, and `data/*.json` as web-accessible so the MAIN-world module graph can import modules and fetch resolver data from `chrome-extension://` URLs. |
| `bridge/*.js`            | content (isolated) | Ordered helper scripts for settings contracts, storage-backed caches, Hoodmaps proxying, Overpass parsing, and transit tile orchestration.                                                                    |
| `bridge.js`              | content (isolated) | Entry/dispatcher. Injects `page.js` as `<script type="module">`, mirrors `chrome.storage.local` ↔ postMessage settings, and routes page-world fetch requests to the helper scripts.                          |
| `page.js`                | MAIN               | Entry. Wires up message listener, hooks `google.maps.Map` constructor, polls DOM for existing maps, registers each map and dispatches `refreshAll`. Also patches history methods to react to SPA navigation. |
| `src/state.js`           | MAIN               | Single source of truth: `state.settings`, `state.maps`, `state.perMap` (WeakMap keyed by map → render state), in-memory caches, source-tag constants.                                                        |
| `src/utils.js`           | MAIN               | `quantizeBbox`, `normalizeColor`, `douglasPeucker`, `detectCitySlug`, `isMapUrl`, `ensureFont`.                                                                                                              |
| `src/transit.js`         | MAIN               | Overpass request orchestration + parser (collapses direction-pair routes, stitches way segments into continuous polylines), polyline rendering.                                                              |
| `src/hoodmaps-resolver.js` | MAIN             | Lazy-loads `data/hoodmaps-coverage-index.json`, resolves the Hoodmaps dataset for the current Google Maps bounds, and breaks overlap ties by nearest dataset center.                                        |
| `src/hoodmaps-data.js`   | MAIN               | Shared Hoodmaps data capability cache. Requests the full `get_data` payload and decides whether district mode, pixel mode, or both are available for the resolved Hoodmaps dataset.                         |
| `src/tags.js`            | MAIN               | `TextOverlay` class (extends `google.maps.OverlayView`), tag placement: vote-rank + pixel-space AABB collision + word-wrap + zoom-tier sizing.                                                               |
| `src/districts.js`       | MAIN               | GeoJSON polygon layer using `google.maps.Data`. Per-category color + per-feature density-driven opacity.                                                                                                     |
| `src/pixels.js`          | MAIN               | Canvas `OverlayView` for Hoodmaps' crowd-painted pixel cells, used when a city lacks categorized district GeoJSON or when the user chooses pixel mode.                                                       |
| `src/controls.js`        | MAIN               | Shadow-DOM "Layers" pill control inserted into `map.controls[LEFT_TOP]`. Syncs the Hoodmaps mode selector to resolved-area capabilities.                                                                     |
| `src/controls-template.js` | MAIN             | HTML/CSS template for the on-map Layers control.                                                                                                                                                             |
| `popup.html`, `popup.js` | popup              | Master on/off + status pill. Talks to `chrome.storage` directly.                                                                                                                                             |

## Non-obvious decisions

These are all "we already debugged this; don't undo it without understanding
why":

### URL gating: search results only

`isMapUrl()` only matches `/s/<city>/(homes|all)` (locale prefixes like
`/fr/...` are stripped first). Listing-detail pages (`/rooms/<id>`) are
explicitly excluded — their map embed is small and the Layers UI gets in
the way. The check runs in both the polling tick and inside `register()`
so the constructor-hook path is also gated.

### Settings race condition on page load

`bridge.js` does an initial fire-and-forget `chrome.storage.local.get()` and
posts the result to `page.js`. If the storage promise resolves before
`page.js` has its message listener attached, the broadcast is lost and
`state.settings` stays at hardcoded defaults forever. The fix: `page.js`
sends a `requestSettings` message on startup (after attaching its listener)
and `bridge.js` responds. The fire-and-forget send still runs as a
fast-path for the lucky-timing case.

### Airbnb is an SPA

Switching destinations changes `location.pathname` via `pushState` without
a real navigation. The map's `idle` event covers pan/zoom changes, but a route
change can swap the active destination without producing the refresh ordering
we need. And during the fetch window for a new city's data, we'd otherwise
show the previous city's overlays.

Two-part fix in `page.js` + the Hoodmaps layer modules:

1. Patch `history.pushState`/`replaceState` and listen for `popstate`.
   When `location.pathname` changes, call `refreshAll` for every
   registered map.
2. In Hoodmaps layer refreshes, clear the stale layer immediately when the
   resolved slug changes (`entry.districtsSlug`, `tagsSlug`, or `pixelsSlug`)
   — _before_ the early-return that waits for the new fetch.

### Hoodmaps color modes

Hoodmaps has two different color data sources:

- `?action=get_data&slug=<city>` includes tags and crowd-painted pixel cells
  (`oneDecimalLessAllUsersPaths`, `highZoomUsersPaths`) for many cities.
- `/assets/districts_categorized/<city>.geojson` exists only when
  `neighborhoodsGeoJSONAvailable` is true in that same `get_data` payload.

Do not fetch district GeoJSON blindly for every city. Cannes, for example,
publishes pixel cells but returns 404 for categorized district GeoJSON. The
Layers menu should show the District / Pixel segmented control whenever any
color mode is available, keeping unavailable options visible but disabled.
Only cities with no color mode at all should fall back to a static message.

Do not assume Airbnb's URL slug is the Hoodmaps slug. Hoodmaps pages cover
bounding boxes, not just searchable city names: Saint-Denis, Antony, and
Boulogne-Billancourt are covered by the Paris dataset even though those slugs
do not have their own Hoodmaps pages. `src/hoodmaps-resolver.js` lazy-loads
`data/hoodmaps-coverage-index.json`, finds datasets whose coverage tiles
overlap the current Google Maps bounds, and picks the dataset center closest to
the map center when multiple datasets overlap. Refresh that generated index
with:

```sh
npm run hoodmaps:index
```

### Tag placement

The placement loop in `src/tags.js` is calibrated to look like Hoodmaps:

- **Discrete zoom tiers** (0–4) instead of continuous zoom: `MIN_VOTES`,
  `zScale`, and `MAX` are constant within a tier so labels don't re-render
  on every zoom step. We also short-circuit refresh entirely if `(tier,
quantized-bbox)` hasn't changed (`entry.tagsRenderKey`).
- **Vote threshold** to drop low-vote noise tags (Hoodmaps does this).
- **Pixel-space AABB collision**: lat/lng radii don't model wide labels —
  a long label is much wider than tall. We project to world pixels via
  `proj.fromLatLngToPoint(...) * 2^zoom` and reject candidates whose
  bounding box overlaps an already-placed one. Bounding box dimensions
  are `fontSize × 0.55 × longest-line-chars` plus size-scaled padding.
- **Word wrap on long labels** (≥34 chars). Single-line labels render
  with `white-space: nowrap` (no `max-width` constraint) so the browser
  can't break a single word mid-character if our width estimate is tight.
- **Vote → font size**: linear `12 + votes × 0.1`, multiplied by per-tier
  `zScale`, clamped 12–44px. Calibrated so Hoodmaps' "+248 votes →
  ~44px" matches.
- **Text shadow**: hoodmaps-style offset shadow (`#454545`, with a
  `3px 3px` drop) — _not_ a symmetric stroke.

### Transit pipeline

Overpass returns route relations + their member ways + the ways' nodes.
`parseOverpass` does three non-trivial steps:

1. **Group direction pairs.** Many cities don't have `route_master`
   relations, so we group by `route + network + ref + colour` and pick
   the variant with the most track-way members. That collapses
   northbound/southbound into a single drawn line.
2. **Stitch.** For each `(mode, color)` bucket, build a graph keyed by
   way endpoints and greedily chain ways into continuous paths so each
   line is one `Polyline` with proper round joins.
3. **Simplify.** Douglas-Peucker with ~3m epsilon.

Bbox is quantized to a 0.05° grid (with 0.02° padding) so small pans
reuse the in-memory page cache and the bridge's storage-backed Overpass
cache.

### ES modules in MAIN world

`bridge.js` injects `page.js` with `type="module"`. The browser resolves
its `import "./src/*.js"` against the `chrome-extension://EXTID/` URL.
This works because all module URLs are listed in
`web_accessible_resources`, and Airbnb's CSP doesn't block
`chrome-extension://` scheme imports for content-script-injected scripts.
If this ever breaks (rare), the fallback is to bundle into a single file
or use sequential plain-script injection sharing `window.__abm`.

## Conventions

Follow the rules in CLAUDE-style guidelines:

- **No speculative abstractions.** Three similar lines beat a premature
  generic helper. Don't add error handling for cases the surrounding code
  guarantees can't happen.
- **No narrating comments.** Don't write _what_ the code does — names
  already do that. Only comment the _why_ when it's non-obvious: a
  past bug, a hidden constraint, a calibration source ("Hoodmaps:
  +248 votes → 44px").
- **Don't reference task context in comments.** No "added for the X
  flow" or "fixes issue #42". That kind of context belongs in commits
  and rots in source.
- **Prefer editing existing files** over creating new ones. The split
  layer modules are already the abstraction line; new layers should
  become a new `src/<layer>.js`, not a sub-folder.
- **Match existing style.** 2-space indent, double quotes, semicolons,
  trailing commas in multi-line objects/arrays.

### Commit messages

- **Keep them short.** Subject line under ~72 chars, present tense
  imperative ("fix X", "split Y into Z"). Add a short body only when
  the _why_ needs explaining; otherwise the subject is enough.
- **Do not add `Co-Authored-By: Claude` (or any AI attribution)
  trailers.** Plain commits, no AI footer.
- **Do not add the "🤖 Generated with Claude Code" footer either.**

## Local test loop

### Required before commit / push

Before committing or pushing changes to `main`, run the Playwright suite:

```sh
npm run test
```

If dependencies or browsers are missing, install them first:

```sh
npm install
npx playwright install chromium
```

The live matrix test intentionally opens the real Airbnb site with the unpacked
extension loaded for the cities in `tests/live/hoodmaps-city-matrix.json`:
Paris for full Hoodmaps data, Cannes for pixel-only data, and Oakland for an
overlapping-bbox resolver case. It also includes Antony because that Airbnb
slug has no Hoodmaps page but should resolve to Paris coverage. Hoodmaps data is
fetched live; transit is deliberately faked by intercepting Overpass and
returning one synthetic horizontal subway relation. The transit assertion only
proves polyline rendering, not real OSM geometry or city-specific route
coverage. The Hoodmaps assertions must prove color overlays are attached to the
Google Map, not just that network data was fetched. If Airbnb shows a captcha
or gate, treat that as a real test result and report it instead of bypassing
the failure silently.

### Manual

1. `chrome://extensions` → toggle the extension off and back on (or
   click its reload icon). This re-reads `manifest.json` and reloads
   all extension scripts.
2. Reload the Airbnb tab. Content scripts only re-inject on a real
   navigation, so a SPA route change won't reload them.
3. DevTools → Console: `bridge.js` logs to the _page's_ console (it's
   in the isolated world but `console.log` shows up in the same tab
   console). `page.js` logs there too. Filter by `[abnb-better-maps]`
   for perf logs and `[abnb-transit]` for transit fetch errors.
4. To inspect storage: DevTools → Application → Storage → Extension
   storage → Local → `transitOverlay`.

### With Claude Code (`chrome-cdp` skill)

If the `chrome-cdp` skill is available, use it to test the extension
in a live Chrome session instead of asking the user to verify manually.

1. Navigate to an Airbnb search page (e.g. `/s/Paris/homes`).
2. Check the console for `[abnb-better-maps:perf]` logs confirming
   the extension injected and layers loaded.
3. Verify the "Layers" pill is visible on the map by inspecting the
   DOM for a shadow host with `.pill` inside `map.controls`.
4. Toggle layers on/off via the controls and confirm polylines /
   district polygons / tag overlays appear or disappear.
5. Check `chrome.storage.local` for cached tile and hoodmaps entries.

Use console reads and DOM inspection through CDP — do not rely solely
on screenshots, since the overlay renders on a Google Maps canvas.

## Things to be careful with

- **Don't add a build step** unless there's a strong reason. Pure JS
  with native ES modules has been deliberate.
- **Don't add `await`s in `register()` or the message handler** without
  thinking about ordering. The current code is sync up until each
  layer's own internal awaits.
- **Don't change message source-tag strings** (`"abnb-transit-overlay"`,
  `"abnb-transit-overlay-page"`) — they're in `state.js` and used in
  both contexts. Renaming requires changing both sides atomically.
- **Don't widen `isMapUrl()` to cover `/rooms/<id>`** without also
  re-introducing the listing-page offset for the controls pill (we
  removed it on purpose).
