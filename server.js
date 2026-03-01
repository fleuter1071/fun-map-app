const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8010;
const DATABASE_URL = process.env.DATABASE_URL || "";
const CLIMATE_WINDOW_YEARS = 5;
const CLIMATE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CLIMATE_FETCH_TIMEOUT_MS = 25000;
const CLIMATE_CONCURRENCY = 4;
const CITY_VERIFY_TIMEOUT_MS = 8000;
const CITY_VERIFY_MAX_DISTANCE_KM = 80;
let climateRecomputeRunning = false;

const CITIES = [{"city":"New York","state":"NY","lat":40.6943,"lon":-73.9249,"pop":8537673},{"city":"Los Angeles","state":"CA","lat":34.114,"lon":-118.4068,"pop":3976322},{"city":"Chicago","state":"IL","lat":41.8373,"lon":-87.6861,"pop":2704958},{"city":"Houston","state":"TX","lat":29.7871,"lon":-95.3936,"pop":2303482},{"city":"Phoenix","state":"AZ","lat":33.5722,"lon":-112.0891,"pop":1615017},{"city":"Philadelphia","state":"PA","lat":40.0076,"lon":-75.134,"pop":1567872},{"city":"San Antonio","state":"TX","lat":29.4722,"lon":-98.5247,"pop":1492510},{"city":"San Diego","state":"CA","lat":32.8312,"lon":-117.1225,"pop":1406630},{"city":"Dallas","state":"TX","lat":32.7938,"lon":-96.7659,"pop":1317929},{"city":"San Jose","state":"CA","lat":37.302,"lon":-121.8488,"pop":1025350},{"city":"Austin","state":"TX","lat":30.3038,"lon":-97.7545,"pop":947890},{"city":"Jacksonville","state":"FL","lat":30.3322,"lon":-81.6749,"pop":880619},{"city":"San Francisco","state":"CA","lat":37.7561,"lon":-122.4429,"pop":870887},{"city":"Columbus","state":"OH","lat":39.9859,"lon":-82.9852,"pop":860090},{"city":"Indianapolis","state":"IN","lat":39.7771,"lon":-86.1458,"pop":855164},{"city":"Fort Worth","state":"TX","lat":32.7813,"lon":-97.3466,"pop":854113},{"city":"Charlotte","state":"NC","lat":35.208,"lon":-80.8308,"pop":842051},{"city":"Seattle","state":"WA","lat":47.6217,"lon":-122.3238,"pop":704352},{"city":"Denver","state":"CO","lat":39.7621,"lon":-104.8759,"pop":693060},{"city":"El Paso","state":"TX","lat":31.8478,"lon":-106.431,"pop":683080},{"city":"Washington","state":"DC","lat":38.9047,"lon":-77.0163,"pop":681170},{"city":"Boston","state":"MA","lat":42.3189,"lon":-71.0838,"pop":673184},{"city":"Detroit","state":"MI","lat":42.3834,"lon":-83.1024,"pop":672795},{"city":"Nashville","state":"TN","lat":36.1714,"lon":-86.7844,"pop":660388},{"city":"Memphis","state":"TN","lat":35.1047,"lon":-89.9773,"pop":652717},{"city":"Portland","state":"OR","lat":45.5372,"lon":-122.65,"pop":639863},{"city":"Oklahoma City","state":"OK","lat":35.4677,"lon":-97.5138,"pop":638367},{"city":"Las Vegas","state":"NV","lat":36.2288,"lon":-115.2603,"pop":632912},{"city":"Louisville","state":"KY","lat":38.1662,"lon":-85.6488,"pop":616261},{"city":"Baltimore","state":"MD","lat":39.3051,"lon":-76.6144,"pop":614664},{"city":"Milwaukee","state":"WI","lat":43.064,"lon":-87.9669,"pop":595047},{"city":"Albuquerque","state":"NM","lat":35.1055,"lon":-106.6476,"pop":559277},{"city":"Tucson","state":"AZ","lat":32.1558,"lon":-110.8777,"pop":530706},{"city":"Fresno","state":"CA","lat":36.7834,"lon":-119.7933,"pop":522053},{"city":"Sacramento","state":"CA","lat":38.5666,"lon":-121.4683,"pop":495234},{"city":"Mesa","state":"AZ","lat":33.4016,"lon":-111.718,"pop":484587},{"city":"Kansas City","state":"MO","lat":39.1239,"lon":-94.5541,"pop":481420},{"city":"Atlanta","state":"GA","lat":33.7627,"lon":-84.4231,"pop":472522},{"city":"Long Beach","state":"CA","lat":33.8059,"lon":-118.161,"pop":470130},{"city":"Colorado Springs","state":"CO","lat":38.8673,"lon":-104.7605,"pop":465101},{"city":"Raleigh","state":"NC","lat":35.8323,"lon":-78.6441,"pop":458880},{"city":"Miami","state":"FL","lat":25.784,"lon":-80.2102,"pop":453579},{"city":"Virginia Beach","state":"VA","lat":36.7335,"lon":-76.0435,"pop":452602},{"city":"Omaha","state":"NE","lat":41.2634,"lon":-96.0453,"pop":446970},{"city":"Oakland","state":"CA","lat":37.7903,"lon":-122.2165,"pop":420005},{"city":"Minneapolis","state":"MN","lat":44.9635,"lon":-93.2679,"pop":413651},{"city":"Tulsa","state":"OK","lat":36.1284,"lon":-95.9037,"pop":403090},{"city":"Arlington","state":"TX","lat":32.6998,"lon":-97.1251,"pop":392772},{"city":"New Orleans","state":"LA","lat":30.0687,"lon":-89.9288,"pop":391495},{"city":"Wichita","state":"KS","lat":37.6894,"lon":-97.344,"pop":389902}];
const DEFAULT_CITIES = CITIES.map((c) => ({ ...c }));

function shouldUseSsl(connectionString) {
  if (!connectionString) return false;
  const lower = connectionString.toLowerCase();
  return !(lower.includes("localhost") || lower.includes("127.0.0.1"));
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static(__dirname));

function isoDate(dateObj) {
  return new Date(dateObj.getTime() - (dateObj.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function cityKey(city) {
  return `${city.city},${city.state}`;
}

function normCityName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normState(value) {
  return String(value || "").trim().toUpperCase();
}

function cityIdentityKey(cityName, stateCode) {
  return `${normCityName(cityName)}|${normState(stateCode)}`;
}

const DEFAULT_CITY_IDENTITY_SET = new Set(DEFAULT_CITIES.map((c) => cityIdentityKey(c.city, c.state)));
const STATE_NAME_TO_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC"
};

function normLooseText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ");
}

function canonicalCityName(value) {
  return normLooseText(value)
    .replace(/\bsaint\b/g, "st")
    .replace(/\bfort\b/g, "ft")
    .replace(/\scity$/g, "")
    .trim();
}

function cityNamesLikelyMatch(inputCity, resultCity) {
  const a = canonicalCityName(inputCity);
  const b = canonicalCityName(resultCity);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return false;
}

function stateCodeFromGeoResult(row) {
  const code = normState(row?.admin1_code || "");
  if (/^[A-Z]{2}$/.test(code)) return code;
  const nameKey = normLooseText(row?.admin1);
  return STATE_NAME_TO_CODE[nameKey] || null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function toPgPlaceholders(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

async function dbAll(sql, params = []) {
  const res = await pool.query(toPgPlaceholders(sql), params);
  return res.rows || [];
}

async function dbGet(sql, params = []) {
  const rows = await dbAll(sql, params);
  return rows[0] || null;
}

async function dbRun(sql, params = []) {
  const res = await pool.query(toPgPlaceholders(sql), params);
  return {
    rowCount: Number(res.rowCount || 0),
    rows: res.rows || []
  };
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      city_key TEXT NOT NULL,
      memory_date TEXT NOT NULL,
      note TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS city_climate_extremes (
      city_key TEXT NOT NULL,
      window_years INTEGER NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      coldest_date TEXT,
      coldest_low_f DOUBLE PRECISION,
      source TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (city_key, window_years)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_cities (
      id BIGSERIAL PRIMARY KEY,
      city TEXT NOT NULL,
      city_norm TEXT NOT NULL,
      state TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      pop INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(city_norm, state)
    )
  `);
}

async function readCustomCities() {
  const rows = await dbAll(
    `SELECT id, city, state, lat, lon, pop, created_at
     FROM custom_cities
     ORDER BY created_at ASC, id ASC`
  );
  return rows.map((r) => ({
    id: Number(r.id),
    city: String(r.city || "").trim(),
    state: normState(r.state),
    lat: Number(r.lat),
    lon: Number(r.lon),
    pop: Number(r.pop) || 0,
    created_at: r.created_at
  }));
}

async function getAllCities() {
  const custom = await readCustomCities();
  return [...DEFAULT_CITIES, ...custom];
}

function parseCityInput(payload) {
  const city = String(payload?.city || "").trim().replace(/\s+/g, " ");
  const state = normState(payload?.state);
  const latRaw = payload?.lat;
  const lonRaw = payload?.lon;
  const popRaw = payload?.pop;
  const hasLat = latRaw !== undefined && latRaw !== null && String(latRaw).trim() !== "";
  const hasLon = lonRaw !== undefined && lonRaw !== null && String(lonRaw).trim() !== "";
  const lat = hasLat ? Number(latRaw) : null;
  const lon = hasLon ? Number(lonRaw) : null;
  const pop = (popRaw === undefined || popRaw === null || String(popRaw).trim() === "") ? null : Number(popRaw);

  if (!city) return { error: "city is required." };
  if (!/^[A-Z]{2}$/.test(state)) return { error: "state must be a 2-letter code." };
  if (hasLat && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return { error: "lat must be between -90 and 90." };
  if (hasLon && (!Number.isFinite(lon) || lon < -180 || lon > 180)) return { error: "lon must be between -180 and 180." };
  if (hasLat !== hasLon) return { error: "lat and lon must be provided together." };
  if (pop != null && (!Number.isFinite(pop) || pop < 0)) return { error: "pop must be 0 or higher." };

  return {
    value: {
      city,
      city_norm: normCityName(city),
      state,
      lat,
      lon,
      pop: pop == null ? null : Math.round(pop)
    }
  };
}

async function fetchJSONWithTimeout(url, timeoutMs = CLIMATE_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function verifyCityCandidate(city) {
  const q = encodeURIComponent(city.city);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=20&language=en&format=json`;
  let payload;
  try {
    payload = await fetchJSONWithTimeout(url, CITY_VERIFY_TIMEOUT_MS);
  } catch (_err) {
    return { ok: false, status: 503, error: "City verification service is unavailable. Please try again." };
  }

  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const filtered = rows.filter((r) => {
    if (String(r?.country_code || "").toUpperCase() !== "US") return false;
    if (stateCodeFromGeoResult(r) !== city.state) return false;
    if (!cityNamesLikelyMatch(city.city, r?.name)) return false;
    return Number.isFinite(Number(r?.latitude)) && Number.isFinite(Number(r?.longitude));
  });

  if (!filtered.length) {
    return { ok: false, status: 400, error: "City/state could not be verified. Check spelling and state code." };
  }

  let best = null;
  for (const row of filtered) {
    const rowLat = Number(row.latitude);
    const rowLon = Number(row.longitude);
    const distKm = (city.lat != null && city.lon != null)
      ? haversineKm(city.lat, city.lon, rowLat, rowLon)
      : 0;
    if (!best || distKm < best.distKm) best = { row, distKm };
  }
  if (!best) {
    return { ok: false, status: 400, error: "City/state could not be verified. Check spelling and coordinates." };
  }
  if (city.lat != null && city.lon != null && best.distKm > CITY_VERIFY_MAX_DISTANCE_KM) {
    return {
      ok: false,
      status: 400,
      error: `Coordinates are too far from ${best.row.name}, ${city.state}. Please verify latitude/longitude.`
    };
  }
  const resolvedLat = Number(best.row.latitude);
  const resolvedLon = Number(best.row.longitude);
  const resolvedPop = Number(best.row.population);
  return {
    ok: true,
    resolved: {
      lat: resolvedLat,
      lon: resolvedLon,
      pop: Number.isFinite(resolvedPop) && resolvedPop >= 0 ? Math.round(resolvedPop) : 0
    }
  };
}

function computeWindowDates(years = CLIMATE_WINDOW_YEARS) {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - years);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

async function fetchColdestForCity(city, startDate, endDate) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_min&start_date=${startDate}&end_date=${endDate}` +
    `&timezone=auto&temperature_unit=fahrenheit`;
  const data = await fetchJSONWithTimeout(url);
  const dates = data?.daily?.time ?? [];
  const lows = data?.daily?.temperature_2m_min ?? [];
  let minLow = null;
  let minDate = null;
  for (let i = 0; i < lows.length; i++) {
    const v = lows[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (minLow == null || v < minLow) {
      minLow = Number(v);
      minDate = dates[i] ?? null;
    }
  }
  return { city_key: cityKey(city), coldest_date: minDate, coldest_low_f: minLow };
}

async function asyncPool(limit, items, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (limit <= items.length) {
      const e = p.finally(() => {
        const i = executing.indexOf(e);
        if (i >= 0) executing.splice(i, 1);
      });
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.allSettled(ret);
}

async function readColdestRows(windowYears = CLIMATE_WINDOW_YEARS) {
  return dbAll(
    `SELECT city_key, window_years, window_start, window_end, coldest_date, coldest_low_f, source, computed_at
     FROM city_climate_extremes
     WHERE window_years = ?
     ORDER BY city_key ASC`,
    [windowYears]
  );
}

async function isClimateDataStale(windowYears = CLIMATE_WINDOW_YEARS, expectedCityCount = DEFAULT_CITIES.length) {
  const row = await dbGet(
    `SELECT MIN(computed_at) AS oldest, COUNT(*) AS cnt
     FROM city_climate_extremes
     WHERE window_years = ?`,
    [windowYears]
  );
  if (!row || Number(row.cnt || 0) < expectedCityCount) return true;
  const oldest = row.oldest ? Date.parse(row.oldest) : NaN;
  if (!Number.isFinite(oldest)) return true;
  return (Date.now() - oldest) > CLIMATE_STALE_MS;
}

async function precomputeColdestDays(windowYears = CLIMATE_WINDOW_YEARS, force = false) {
  if (climateRecomputeRunning) return { started: false, reason: "already-running" };
  const targetCities = await getAllCities();
  if (!force) {
    const stale = await isClimateDataStale(windowYears, targetCities.length);
    if (!stale) return { started: false, reason: "fresh" };
  }
  climateRecomputeRunning = true;
  const { startDate, endDate } = computeWindowDates(windowYears);
  const computedAt = new Date().toISOString();
  try {
    const settled = await asyncPool(CLIMATE_CONCURRENCY, targetCities, async (city) => {
      const result = await fetchColdestForCity(city, startDate, endDate);
      await dbRun(
        `INSERT INTO city_climate_extremes
         (city_key, window_years, window_start, window_end, coldest_date, coldest_low_f, source, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(city_key, window_years) DO UPDATE SET
           window_start=excluded.window_start,
           window_end=excluded.window_end,
           coldest_date=excluded.coldest_date,
           coldest_low_f=excluded.coldest_low_f,
           source=excluded.source,
           computed_at=excluded.computed_at`,
        [
          result.city_key,
          windowYears,
          startDate,
          endDate,
          result.coldest_date,
          result.coldest_low_f,
          "archive_5y",
          computedAt
        ]
      );
    });
    const failed = settled.filter((x) => x.status !== "fulfilled").length;
    return { started: true, failed };
  } finally {
    climateRecomputeRunning = false;
  }
}

app.get("/api/memories", async (_req, res) => {
  try {
    const rows = await dbAll(
      "SELECT id, city_key, memory_date, note FROM memories ORDER BY memory_date DESC, id DESC"
    );
    res.json(rows || []);
  } catch (_err) {
    res.status(500).json({ error: "Failed to load memories." });
  }
});

app.post("/api/memories", async (req, res) => {
  const city_key = String(req.body?.city_key || "").trim();
  const memory_date = String(req.body?.memory_date || "").trim();
  const note = String(req.body?.note || "").trim();

  if (!city_key || !memory_date || !note) {
    res.status(400).json({ error: "city_key, memory_date, and note are required." });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(memory_date)) {
    res.status(400).json({ error: "memory_date must be YYYY-MM-DD." });
    return;
  }

  try {
    const row = await dbGet(
      `INSERT INTO memories(city_key, memory_date, note)
       VALUES (?, ?, ?)
       RETURNING id, city_key, memory_date, note`,
      [city_key, memory_date, note]
    );
    res.status(201).json(row);
  } catch (_err) {
    res.status(500).json({ error: "Failed to save memory." });
  }
});

app.delete("/api/memories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid memory id." });
    return;
  }
  try {
    const result = await dbRun("DELETE FROM memories WHERE id = ?", [id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Memory not found." });
      return;
    }
    res.json({ ok: true, id });
  } catch (_err) {
    res.status(500).json({ error: "Failed to delete memory." });
  }
});

app.get("/api/cities", async (_req, res) => {
  try {
    const customRows = await readCustomCities();
    const rows = [
      ...DEFAULT_CITIES.map((c) => ({ ...c, source: "default" })),
      ...customRows.map((c) => ({ ...c, source: "custom" }))
    ];
    res.json({
      rows,
      defaultCount: DEFAULT_CITIES.length,
      customCount: customRows.length,
      totalCount: rows.length
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load cities." });
  }
});

app.post("/api/cities", async (req, res) => {
  const parsed = parseCityInput(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const city = parsed.value;
  const identity = cityIdentityKey(city.city, city.state);
  if (DEFAULT_CITY_IDENTITY_SET.has(identity)) {
    res.status(409).json({ error: "City already exists in default map set." });
    return;
  }

  try {
    const verification = await verifyCityCandidate(city);
    if (!verification.ok) {
      res.status(verification.status || 400).json({ error: verification.error || "City verification failed." });
      return;
    }
    const resolved = verification.resolved || {};
    const lat = (city.lat != null && Number.isFinite(Number(city.lat))) ? Number(city.lat) : Number(resolved.lat);
    const lon = (city.lon != null && Number.isFinite(Number(city.lon))) ? Number(city.lon) : Number(resolved.lon);
    const pop = (city.pop != null && Number.isFinite(Number(city.pop))) ? Number(city.pop) : Number(resolved.pop || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: "Could not resolve city coordinates from city/state." });
      return;
    }

    const found = await dbGet(
      `SELECT id FROM custom_cities WHERE city_norm = ? AND state = ? LIMIT 1`,
      [city.city_norm, city.state]
    );
    if (found) {
      res.status(409).json({ error: "City already exists." });
      return;
    }

    const inserted = await dbGet(
      `INSERT INTO custom_cities (city, city_norm, state, lat, lon, pop)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [city.city, city.city_norm, city.state, lat, lon, Math.max(0, Math.round(pop))]
    );
    const saved = await dbGet(
      `SELECT id, city, state, lat, lon, pop, created_at
       FROM custom_cities
       WHERE id = ?`,
      [inserted.id]
    );

    precomputeColdestDays(CLIMATE_WINDOW_YEARS, false).catch((err) => {
      console.error("post-create coldest precompute failed:", err?.message || err);
    });

    res.status(201).json({
      ...saved,
      source: "custom"
    });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE") || String(err?.code || "") === "23505") {
      res.status(409).json({ error: "City already exists." });
      return;
    }
    res.status(500).json({ error: "Failed to save city." });
  }
});

app.get("/api/coldest-days", async (req, res) => {
  const window = String(req.query.window || "5y").toLowerCase().trim();
  if (window !== "5y") {
    res.status(400).json({ error: "Only window=5y is supported." });
    return;
  }
  try {
    const expectedCityCount = (await getAllCities()).length;
    const stale = await isClimateDataStale(CLIMATE_WINDOW_YEARS, expectedCityCount);
    if (stale && !climateRecomputeRunning) {
      precomputeColdestDays(CLIMATE_WINDOW_YEARS, false).catch((err) => {
        console.error("coldest precompute failed:", err?.message || err);
      });
    }
    const rows = await readColdestRows(CLIMATE_WINDOW_YEARS);
    res.json({
      window: "5y",
      source: "archive_5y_precompute",
      stale,
      computing: climateRecomputeRunning,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load coldest-day data." });
  }
});

app.post("/api/admin/recompute-coldest", async (req, res) => {
  try {
    const result = await precomputeColdestDays(CLIMATE_WINDOW_YEARS, true);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Failed to recompute coldest-day data." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function startServer() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set your Supabase Postgres connection string.");
  }

  await initDatabase();

  app.listen(PORT, () => {
    console.log(`Memory Map server running at http://127.0.0.1:${PORT}`);
    precomputeColdestDays(CLIMATE_WINDOW_YEARS, false).catch((err) => {
      console.error("initial coldest precompute failed:", err?.message || err);
    });
  });
}

startServer().catch((err) => {
  console.error("Server startup failed:", err?.message || err);
  process.exit(1);
});
