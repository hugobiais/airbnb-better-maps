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
- **ISOLATED world** (`bridge.js`) is required for `chrome.storage` and
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
`tagsRequest`/`tagsResponse`, `districtsRequest`/`districtsResponse`.

## File map

| File                     | World              | Responsibility                                                                                                                                                                                               |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json`          | —                  | MV3 config. Host permissions for every Airbnb TLD. Exposes `page.js` and `src/*.js` as web-accessible so the MAIN-world module graph can `import` from `chrome-extension://` URLs.                           |
| `bridge.js`              | content (isolated) | Injects `page.js` as `<script type="module">`. Mirrors `chrome.storage.local` ↔ postMessage settings. Proxies hoodmaps.com tag + district fetches with a 24h `chrome.storage.local` cache.                   |
| `page.js`                | MAIN               | Entry. Wires up message listener, hooks `google.maps.Map` constructor, polls DOM for existing maps, registers each map and dispatches `refreshAll`. Also patches history methods to react to SPA navigation. |
| `src/state.js`           | MAIN               | Single source of truth: `state.settings`, `state.maps`, `state.perMap` (WeakMap keyed by map → render state), in-memory caches, source-tag constants.                                                        |
| `src/utils.js`           | MAIN               | `quantizeBbox`, `normalizeColor`, `douglasPeucker`, `detectCitySlug`, `isMapUrl`, `ensureFont`.                                                                                                              |
| `src/transit.js`         | MAIN               | Overpass fetch + parser (collapses direction-pair routes, stitches way segments into continuous polylines), polyline rendering.                                                                              |
| `src/tags.js`            | MAIN               | `TextOverlay` class (extends `google.maps.OverlayView`), tag placement: vote-rank + pixel-space AABB collision + word-wrap + zoom-tier sizing.                                                               |
| `src/districts.js`       | MAIN               | GeoJSON polygon layer using `google.maps.Data`. Per-category color + per-feature density-driven opacity.                                                                                                     |
| `src/controls.js`        | MAIN               | Shadow-DOM "Layers" pill control inserted into `map.controls[LEFT_TOP]`. HTML template inlined at the bottom of the file.                                                                                    |
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
a real navigation. The map's `idle` event covers transit + tags (because
the map pans), but **not** districts (the GeoJSON layer is independent of
viewport). And during the fetch window for a new city's data, we'd
otherwise show the previous city's overlays.

Two-part fix in `page.js` + `src/districts.js` + `src/tags.js`:

1. Patch `history.pushState`/`replaceState` and listen for `popstate`.
   When `location.pathname` changes, call `refreshAll` for every
   registered map.
2. In `refreshDistricts` and `refreshTags`, clear the stale layer
   immediately when `entry.districtsSlug !== slug` (or `tagsSlug !== slug`)
   — _before_ the early-return that waits for the new fetch.

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
reuse the cache.

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

## Local test loop

1. `chrome://extensions` → toggle the extension off and back on (or
   click its reload icon). This re-reads `manifest.json` and reloads
   all extension scripts.
2. Reload the Airbnb tab. Content scripts only re-inject on a real
   navigation, so a SPA route change won't reload them.
3. DevTools → Console: `bridge.js` logs to the _page's_ console (it's
   in the isolated world but `console.log` shows up in the same tab
   console). `page.js` logs there too. Filter by `[abnb-transit]` for
   transit fetch errors.
4. To inspect storage: DevTools → Application → Storage → Extension
   storage → Local → `transitOverlay`.

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
