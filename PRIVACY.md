# Privacy Policy — Airbnb Better Maps

_Last updated: 2026-05-04._

## Summary

Airbnb Better Maps does not collect, transmit, or sell any personal data.
The extension runs entirely in your browser. There is no analytics, no
telemetry, no remote backend operated by us, and no user account.

## What the extension stores locally

The extension uses Chrome's local extension storage (`chrome.storage.local`)
to remember:

- Your layer preferences (which overlays are enabled, opacity, category
  toggles).
- A 24-hour cache of the public neighborhood data fetched from
  hoodmaps.com (so the same data isn't re-downloaded every time you
  switch tabs).

This data lives on your device only. Uninstalling the extension removes it.

## What the extension fetches from the internet

To draw the overlays, the extension makes requests to the following
public APIs. No user-identifying data is sent in these requests — only
the geographic bounding box of the visible map area, or the city slug
visible in your Airbnb URL.

| Endpoint                                              | Purpose                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `https://overpass-api.de/api/interpreter`             | OpenStreetMap transit-line geometry for the visible area. |
| `https://hoodmaps.com/?action=get_data&slug=<city>`   | Hoodmaps neighborhood text labels for the current city.   |
| `https://hoodmaps.com/assets/districts_categorized/…` | Hoodmaps neighborhood category polygons.                  |
| `https://fonts.googleapis.com/css2?family=Nunito…`    | Loads the Nunito web font used for tag labels.            |

These endpoints are operated by third parties under their own privacy
policies:

- OpenStreetMap / Overpass: <https://wiki.openstreetmap.org/wiki/Privacy_policy>
- Hoodmaps: <https://hoodmaps.com/>
- Google Fonts: <https://policies.google.com/privacy>

## What permissions the extension requests, and why

- **Storage** — to save your layer preferences and cache neighborhood
  data locally (see above).
- **Scripting** — used by the toolbar popup to detect whether the
  active Airbnb tab has a Google Map visible, so the popup can show a
  "map found" status indicator. No code is injected into pages other
  than `bridge.js` (declared in the manifest).
- **Host access to Airbnb domains** — required to inject the overlay
  script onto Airbnb search-results pages. The overlay only activates
  on `/s/<city>/(homes|all)` URLs.
- **Host access to `hoodmaps.com`** — required to fetch the
  neighborhood data described above.

## What the extension does not do

- It does not read or transmit your Airbnb account, search history,
  saved listings, or any other personal information.
- It does not modify Airbnb's pages beyond drawing overlays on the map.
- It does not communicate with any server operated by us.
- It does not include analytics or tracking SDKs.

## Contact

For questions or concerns, open an issue at the project's source
repository.
