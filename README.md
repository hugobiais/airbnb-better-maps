# Airbnb Better Maps

Chrome extension (Manifest V3) that overlays useful neighborhood data on
Airbnb's map view, so you can pick a place to stay based on what actually
matters to you.

## Layers

- **Transit lines** — subway, tram, light rail, and commuter rail, sourced
  from OpenStreetMap via the Overpass API. Colors come from each line's OSM
  `colour` tag where available.
- **Neighborhood zones** — Hoodmaps' categorical regions (Hipsters, Suits,
  Rich, Tourists, University, Normies, Nightlife, Crime) shown as colored
  district polygons where available, or as Hoodmaps' crowd-painted pixel cells
  in cities that do not publish district GeoJSON.
- **Hoodmaps tags** — short crowdsourced labels ("a LOT of tourists", "Rich
  person farmer's market", etc.), filtered and sized by vote count.

All layers are toggleable from the **Layers** pill on the top-left of the map.
For Hoodmaps colors, the menu shows a District / Pixel selector whenever a
color mode is available for the current map area. The extension resolves the
active Hoodmaps dataset from Airbnb's visible map bounds, so suburbs that are
covered by a nearby Hoodmaps city (for example Saint-Denis → Paris) still show
the available neighborhood data. Unavailable modes stay visible but disabled.
The toolbar popup has a master on/off switch and a status indicator.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open an Airbnb search page, e.g.
   <https://www.airbnb.com/s/San-Francisco--California/homes>.

The extension only activates on Airbnb search-results URLs (`/s/<city>/homes`
or `/s/<city>/all`). Listing-detail pages (`/rooms/<id>`) are intentionally
skipped.

## Live test

Install dependencies and Playwright's Chromium once:

```sh
npm install
npx playwright install chromium
```

Run the full Playwright suite:

```sh
npm run test
```

The live matrix opens the Airbnb search pages listed in
`tests/live/hoodmaps-city-matrix.json` with the unpacked extension loaded:
Paris for full Hoodmaps data, Cannes for pixel-only data, and Oakland for an
overlapping-bbox resolver case. It also includes Antony because that Airbnb
slug has no Hoodmaps page but should resolve to Paris coverage. It fails
explicitly if Airbnb shows a captcha/gate, verifies Google Maps and the Layers
control, enables Hoodmaps plus the default transit layer, and asserts that
transit lines and Hoodmaps color overlays attach to the map. Hoodmaps data is
fetched live; transit is deliberately faked. The test intercepts Overpass and
returns one synthetic horizontal subway relation, so the transit assertion only
proves that the extension draws polylines on the map. It does not validate real
OSM transit geometry or city-specific route coverage.

To refresh the offline Hoodmaps coverage index used by the resolver:

```sh
npm run hoodmaps:index
```

## Credits

- Transit geometry: [OpenStreetMap](https://www.openstreetmap.org/) contributors,
  via the [Overpass API](https://overpass-api.de/).
- Neighborhood zones, pixels, and tags: [Hoodmaps](https://hoodmaps.com/).

## Contributing / hacking

See [AGENTS.md](./AGENTS.md) for architecture, file responsibilities, and the
non-obvious decisions behind the current code (SPA navigation, race
conditions, label placement, etc.). It's written for AI coding agents but
works just as well as a human onboarding doc.
