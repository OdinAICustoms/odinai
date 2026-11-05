-- 009_export.sql — export declarations (phase 3a).
-- Carried over from ODIN LINK 2.37 (src/export/codes.js, validation.js, refdata.js), following Tolletaten's
-- "Hvordan fylle ut utførselsdeklarasjon steg-for-steg". An export declaration is a declaration with
-- direction EXPORT: the same parties, goods items, versions, approval and send queue as import, plus the
-- boxes only export has. Export numbers are EXP-<year>-<number> from the same sequence as import.

/* ---------------- reference data ---------------- */
CREATE TABLE ref_export_restriction (        -- utfoerselsrestriksjon
  id           bigserial PRIMARY KEY,
  code         text NOT NULL,
  landgruppe   text,
  rtype        text NOT NULL,                -- U1, U2, L3, B3, FD, W1, M4 ...
  rtype_text   text,
  rgroup       integer,
  rgroup_text  text,
  valid_from   date,
  valid_to     date
);
CREATE INDEX ref_export_restriction_code ON ref_export_restriction (code);

CREATE TABLE ref_export_levy (               -- utfoerselsavgift
  id          bigserial PRIMARY KEY,
  code        text NOT NULL,
  landgruppe  text,
  levy_type   text NOT NULL,
  levy_text   text,
  levy_group  integer,
  group_text  text,
  rate        numeric NOT NULL,
  unit        text,                          -- P = per cent of the statistical value
  unit_text   text,
  valid_from  date,
  valid_to    date
);
CREATE INDEX ref_export_levy_code ON ref_export_levy (code);

CREATE TABLE ref_export_ref (                -- utfoerselsreferanse: box 44 codes on export
  code        text PRIMARY KEY,
  text        text,
  valid_from  date,
  valid_to    date
);

CREATE TABLE ref_exit_office (               -- box 29: utpasseringstollsted (4 digits)
  code             text PRIMARY KEY,
  name             text NOT NULL,
  illogical_modes  text[] NOT NULL DEFAULT '{}'   -- box 25 modes Tolletaten marks as illogical for the office
);

/* ---------------- the declaration ---------------- */
-- Box 1 and box 25 use other code lists on export (1/2/3/8/0; 10, 12, 16 ... 90): checked in code instead.
ALTER TABLE declaration DROP CONSTRAINT IF EXISTS declaration_decl_type_check;
ALTER TABLE declaration DROP CONSTRAINT IF EXISTS declaration_transport_mode_check;

ALTER TABLE declaration ADD COLUMN destination_country text;   -- box 17a
ALTER TABLE declaration ADD COLUMN exit_office text;           -- box 29
ALTER TABLE declaration ADD COLUMN storage_type text;          -- box 30 on export: A–E
ALTER TABLE declaration ADD COLUMN invoice_type text;          -- box 28: N380 / N325 / ZZZ
ALTER TABLE declaration ADD COLUMN invoice_no text;
ALTER TABLE declaration ADD COLUMN invoice_date date;
ALTER TABLE declaration ADD COLUMN fx_manual numeric;          -- box 23, when Tolletaten has no rate

ALTER TABLE declaration_item ADD COLUMN county text;           -- box 34b
ALTER TABLE declaration_item ADD COLUMN container_no text;     -- box 31
ALTER TABLE declaration_item ADD COLUMN chassis text;          -- box 31 (restriction M4)
ALTER TABLE declaration_item ADD COLUMN stat_value numeric(16,2);   -- box 46 set by hand (FOB Norwegian border, repair cost ...)
ALTER TABLE declaration_item ADD COLUMN levy_group text;       -- box 47: the export levy group when several apply

CREATE INDEX declaration_direction ON declaration (direction, status);
