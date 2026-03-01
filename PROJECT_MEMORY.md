Final Feature Summary - Feb 24 2026 6:32 PM ET

  Feature name

  - Coldest Day (Best Available) filter + 5-year precompute backend

  What was implemented

  - Added a new color filter option: Coldest Day (Best Available).
  - Implemented coldest-day data derivation and display in hover tooltips.

  Files changed

  - index.html
  - styles/main.css
  - src/main.js
  - server.js

  Assumptions made

  - “Best available” means:
      - Use 5-year precomputed coldest data when present.
      - Otherwise fall back to currently loaded weather window.
  - 5-year window is sufficient for this feature and acceptable performance-wise.
  - Recompute can run on startup and via manual admin endpoint.

  Known limitations

  - Not true all-time record; only last 5 years (or fallback window).
  - Precompute may take time initially; some cities can temporarily show fallback values.
  - Frontend polling for precompute completion is periodic (not real-time push).

  Manual test checklist

  1. Open Customize > Color and select Coldest Day (Best Available).
  2. Hover multiple cities; verify hero shows coldest low/date (not current temp as primary).
  3. Confirm tooltip source label:
      - “last 5 years” when precompute exists.
      - “loaded data window” only when fallback is used.
  4. Click dots in Coldest mode; verify pinning is disabled and pinned panel hidden.
  5. Switch back to Temp/Precip/AQI; verify pin behavior returns to normal.
  6. Confirm header coldest note displays correctly (not vertically broken).
  7. Hit GET /api/coldest-days?window=5y and verify rows/stale/computing payload.
  8. Optionally trigger POST /api/admin/recompute-coldest and verify updates.
## Date/time
2026-02-25 17:42:12 -05:00

## Feature name
Custom City Add Flow + Spooky Movie Metadata

## Summary
Implemented end-to-end support for adding custom cities (API + DB + UI), including server-side city/state verification and coordinate resolution, plus Spooky Mode enhancements that externalize horror city metadata and show movie + year in the hover.

## Files changed
- C:\Users\dougs\Weather_Map_Cities_2_Codex\server.js
- C:\Users\dougs\Weather_Map_Cities_2_Codex\src\main.js
- C:\Users\dougs\Weather_Map_Cities_2_Codex\index.html
- C:\Users\dougs\Weather_Map_Cities_2_Codex\styles\main.css
- C:\Users\dougs\Weather_Map_Cities_2_Codex\src\config\horror-cities.js

## Assumptions
- Add-city supports U.S. city/state pairs only.
- Geocoding/provider availability is required to resolve unknown city coordinates when not supplied.
- Custom cities should behave like first-class cities in map rendering and weather data fetch flows.

## Known limitations
- City verification depends on external geocoding uptime and match quality.
- Duplicate detection is normalization-based and may still allow edge-case near-duplicates.
- Existing custom city management UX (edit/delete/bulk import) is not implemented yet.

## Remaining TODOs
- Add edit/delete controls for custom cities.
- Add better duplicate disambiguation UX for similarly named cities.
- Add automated API and UI tests for add-city validation and error states.
- Document custom city behavior and failure modes in README.

## Next steps
1. Run through the manual add-city checklist in UI (success, duplicate, invalid city, provider outage).
2. Add regression tests for /api/cities create/list and front-end modal submission states.
3. Implement custom city management (remove/edit) in the UI.
