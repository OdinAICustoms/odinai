-- 002_reference_data.sql — Tolletaten's open data (data.toll.no) and Posten's postal codes.
-- Every table is replaced as a whole by its loader (src/refdata), in one transaction, and every
-- run is recorded in ref_sync so "how old is this data" always has an answer.
--
-- Rules learned from the live data in ODIN LINK (kept here so nobody relearns them):
--   * commodity codes are stored as 8 digits, no spaces ("21039099"); shown as "2103 90 99"
--   * rates arrive as strings with a decimal comma ("24,67") and are stored as exact numerics
--   * an open-ended validity is published as "" and stored as NULL
--   * country-group codes are not prefix-safe (TAL and TALL differ): always exact equality
--   * some currencies are quoted per 100 units (omregningsenhet)

CREATE TABLE tariff (
  code         text PRIMARY KEY,             -- digits: 2 chapter, 4 heading, 6 subheading, 8 declarable
  display      text NOT NULL,                -- "2103 90 99"
  level        text NOT NULL CHECK (level IN ('Chapter', 'Heading', 'Subheading', 'Code', 'Other')),
  text         text,                         -- the tariff's own wording (never box 31 on a declaration)
  path_text    text,                         -- ancestors > ... > this line
  hs_code      text,
  blv          boolean,
  supp_unit    text,                         -- enhet, e.g. "STK" (supplementary unit, box 41)
  supp_text    text,
  section      text,
  chapter      text,
  parent       text,
  valid_from   date,
  valid_to     date,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tariff_chapter ON tariff (chapter);
CREATE INDEX tariff_parent ON tariff (parent);
CREATE INDEX tariff_text_search ON tariff USING gin (to_tsvector('norwegian', coalesce(path_text, text, '')));

CREATE TABLE tariff_rate (
  code        text NOT NULL,
  landgruppe  text NOT NULL,
  duty_code   text NOT NULL CHECK (duty_code IN ('TL1', 'RT100')),
  rate_value  numeric,                       -- NULL = not published (never read as zero)
  rate_unit   text NOT NULL CHECK (rate_unit IN ('PERCENT', 'SPECIFIC')),
  unit_code   text,                          -- satsEnhet: P = per cent, K = per kg, ...
  unit_text   text,
  valid_from  date NOT NULL,
  valid_to    date,
  PRIMARY KEY (code, landgruppe, duty_code, valid_from)
);
CREATE INDEX tariff_rate_code ON tariff_rate (code, duty_code);

CREATE TABLE landgruppe (
  code             text PRIMARY KEY,
  name             text,
  preference_code  text,
  valid_from       date,
  valid_to         date
);

CREATE TABLE country (
  code  text PRIMARY KEY,                    -- ISO 3166 alpha-2
  name  text NOT NULL
);

CREATE TABLE landgruppe_country (
  landgruppe    text NOT NULL,
  country_code  text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date,
  PRIMARY KEY (landgruppe, country_code, valid_from)
);
CREATE INDEX landgruppe_country_country ON landgruppe_country (country_code);

CREATE TABLE restriction (
  id                      bigserial PRIMARY KEY,
  code                    text NOT NULL,
  landgruppe              text,              -- RALL = all countries, RFO = Faroes, ...
  landgruppe_text         text,
  applies_to              text,              -- avsenderland (box 15) | opprinnelsesland (box 34)
  restriction_code        text,              -- V5, VT, ...
  restriction_text        text,
  restriction_group       integer,           -- 100 permit, 200 notification, ...
  restriction_group_text  text,
  document_code           text,              -- CHED / C400 only when the text says so
  authority               text,
  valid_from              date,
  valid_to                date
);
CREATE INDEX restriction_code ON restriction (code);

CREATE TABLE tvinn_error_code (
  number  text PRIMARY KEY,
  text    text NOT NULL,
  box     text                               -- the declaration box to send the user to (hand-mapped)
);

CREATE TABLE currency (
  code  text PRIMARY KEY,
  name  text
);

-- Tolletaten's customs exchange rates, stored per published period (not one row per day).
CREATE TABLE fx_rate (
  currency    text NOT NULL,
  valid_from  date NOT NULL,
  valid_to    date,
  rate        numeric NOT NULL,              -- NOK per ONE unit, after dividing by per_unit
  quoted      numeric NOT NULL,              -- as published
  per_unit    integer NOT NULL DEFAULT 1,    -- omregningsenhet
  PRIMARY KEY (currency, valid_from)
);

CREATE TABLE postnummer (
  postnr       text NOT NULL,
  poststed     text NOT NULL,
  kommunenr    text,
  kommunenavn  text,
  kategori     text,
  PRIMARY KEY (postnr, poststed)
);
CREATE INDEX postnummer_sted ON postnummer (poststed);

CREATE TABLE ref_sync (
  id            bigserial PRIMARY KEY,
  dataset       text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('RUNNING', 'OK', 'FAILED', 'REFUSED')),
  rows_seen     integer,
  rows_written  integer,
  source_url    text,
  message       text,
  triggered_by  uuid REFERENCES users(id)    -- NULL = the daily schedule
);
CREATE INDEX ref_sync_dataset ON ref_sync (dataset, started_at DESC);
