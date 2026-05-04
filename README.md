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
  polygons.
- **Hoodmaps tags** — short crowdsourced labels ("a LOT of tourists", "Rich
  person farmer's market", etc.), filtered and sized by vote count.

All layers are toggleable from the **Layers** pill on the top-left of the map.
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

## Credits

- Transit geometry: [OpenStreetMap](https://www.openstreetmap.org/) contributors,
  via the [Overpass API](https://overpass-api.de/).
- Neighborhood zones and tags: [Hoodmaps](https://hoodmaps.com/).

## Contributing / hacking

See [AGENTS.md](./AGENTS.md) for architecture, file responsibilities, and the
non-obvious decisions behind the current code (SPA navigation, race
conditions, label placement, etc.). It's written for AI coding agents but
works just as well as a human onboarding doc.
