# Airbnb Better Maps

Chrome extension (MV3) that adds two layers to Airbnb's Google Maps view:

- **Transit lines** (subway, tram, light rail, commuter rail) sourced from
  OpenStreetMap via the Overpass API.
- **Neighborhood character zones** (hipsters, university, rich, suits, normies,
  tourists, nightlife, crime) plus crowdsourced text labels, sourced from
  hoodmaps.com.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Open or reload an Airbnb search page (e.g. https://www.airbnb.com/s/Stockholm--Sweden/homes)

The popup (toolbar icon) toggles the overlay and individual modes.

## How it works

- `bridge.js` (content script) injects `page.js` into the page's MAIN world so it
  can see `window.google.maps`, then forwards settings from `chrome.storage`
  via `postMessage`.
- `page.js` wraps `google.maps.Map` so every map Airbnb constructs is
  registered. On each map's `idle` event it queries the Overpass API for
  `route=subway|tram|light_rail|train` relations in the visible bbox, and draws
  each way segment as a `google.maps.Polyline` using the OSM `colour` tag (with
  a per-mode fallback).
- Bbox is quantized to a 0.05° grid and cached in memory so panning slightly
  doesn't refetch.

## Known limitations

- Overpass can be slow or rate-limit; first paint after a big pan may take a few
  seconds. Consider switching to `overpass.kumi.systems` if the main endpoint is
  saturated.
- Only renders line geometry — no station markers or labels yet.
- OSM `colour` tags are inconsistent across regions; lines without a colour fall
  back to a per-mode default.
- Airbnb sometimes recreates maps on filter changes — the constructor hook
  handles this, but maps created before the extension loads are picked up via a
  one-time DOM scan only.

## Files

- `manifest.json` — MV3 manifest
- `bridge.js` — content script (ISOLATED world)
- `page.js` — main-world injection: hooks Map, fetches Overpass, draws polylines
- `popup.html` / `popup.js` — toolbar UI
