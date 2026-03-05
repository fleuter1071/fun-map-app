# Weather App Handoff

## Product Snapshot
- App: US weather map focused on top cities with time-lapse weather exploration.
- Core value: fast visual scan of current/forecast conditions plus contextual layers (AQI, memory notes, sports schedule, census profile).
- Primary user actions:
1. Scrub timeline and inspect city conditions.
2. Add a custom city.
3. Save and revisit memory notes by city/date.

## Current UX State
- Header has updated contrast and clearer hierarchy.
- Timeline is on **Timeline v1** (single-row control).
- Header info `"i"` control has been removed.
- Bottom status/HUD is desktop-friendly and no longer blocks Alaska.
- `+ Add City` and `Log Memory` are forced to single-line labels.
- Minor viewport-height sensitivity may still appear at some desktop sizes.

## Frontend Architecture
- Entry: `index.html`
- Main logic: `src/main.js`
- Styles: `styles/main.css`
- Pattern: client-driven app with a large controller (`main.js`) handling rendering, state, data fetches, UI interaction, and mode/theme behavior.
- Runtime CDN dependencies with fallbacks:
1. `d3`
2. `topojson-client`
3. US atlas topojson data

## Backend Architecture
- Server: `server.js`
- Stack: Express + SQLite in local dev, Postgres/Supabase in non-dev.
- Default local port: `8010`.
- API routes:
1. `GET /api/memories`
2. `POST /api/memories`
3. `DELETE /api/memories/:id`
4. `GET /api/cities`
5. `POST /api/cities`
6. `GET /api/coldest-days`
7. `POST /api/admin/recompute-coldest`
- Catch-all route serves the frontend app shell.

## Data Sources & Integrations
- Weather and historical weather: Open-Meteo.
- Air quality: WAQI token API.
- Sports context: ESPN scoreboard APIs (NFL, NBA, MLB, NHL).
- City demographics/profile: US Census ACS profile API.
- Browser-side caching: `localStorage` for weather and derived data.

## Database Model
- Schema file: `supabase/schema.sql`
- Tables:
1. `memories`
2. `city_climate_extremes`
3. `custom_cities`
- Local dev DB: `database.sqlite` (project root).

## Feature Surface
- Map color modes: temperature, precipitation, AQI, coldest-day.
- Theme/mode variants: default, spooky, upside-down.
- Timeline controls: now through +72h with play/pause.
- Map interactions: hover tooltip, pin/unpin city cards, zoom/pan/reset, locate user, shareable link.
- Memory flow: create, list per city, revisit by date, delete.

## Run & Environment
- Scripts (`package.json`):
1. `npm start`
2. `npm run dev`
- Env template: `.env.example`
- `NODE_ENV=development` uses SQLite automatically.
- Non-dev requires `DATABASE_URL` for Supabase/Postgres.

## Known Constraints / Risks
- `src/main.js` is large and multi-responsibility (state, data, rendering, interactions), which raises change risk.
- Runtime UX depends on third-party APIs/CDNs.
- No `npm test` script currently defined.
- Header/layout tuning is custom and can be sensitive across edge breakpoints.

## Recommended Next Steps
1. Freeze a baseline UI and capture desktop/tablet/mobile reference screenshots.
2. Create a compact design token guide for header/timeline/map HUD to reduce visual drift.
3. Refactor `src/main.js` into modules (`api`, `state`, `map-render`, `ui-controls`, `themes`).
4. Add smoke tests for API routes and one browser E2E flow for timeline + memory CRUD.
5. Add fallback/error-state handling standards for WAQI/ESPN/Census failures.
6. Define a release checklist (env vars, DB mode, startup, viewport QA).
