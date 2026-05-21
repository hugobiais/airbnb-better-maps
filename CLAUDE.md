# CLAUDE.md

Follow [AGENTS.md](./AGENTS.md) for architecture and codebase conventions.

Before committing or pushing changes to `main`, run:

```sh
npm run test
```

If needed, install the local test dependencies and browser first:

```sh
npm install
npx playwright install chromium
```

The live matrix test opens the real Airbnb site with the unpacked extension
loaded for Paris, Cannes, Oakland, and Antony from
`tests/live/hoodmaps-city-matrix.json`. Hoodmaps data is fetched live; Overpass
is intercepted with one synthetic horizontal subway relation. The transit
assertion proves polyline rendering only, not real OSM geometry. The Hoodmaps
assertions must prove color overlays attach to the Google Map. If Airbnb shows a
captcha or gate, report that result directly.

The Hoodmaps bbox resolver uses `data/hoodmaps-coverage-index.json`. Refresh it
with `npm run hoodmaps:index` when Hoodmaps coverage pages need to be
regenerated.
