-- Weather Map app schema for Supabase Postgres

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  city_key TEXT NOT NULL,
  memory_date TEXT NOT NULL,
  note TEXT NOT NULL
);

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
);

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
);
