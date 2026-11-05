-- 005_declarations.sql — import declarations (phase 2a) and the reference data they first need.
-- Carried over from ODIN LINK 2.37 (src/validation.js, src/sad.js, src/refsets.js), with the SAD boxes
-- as real columns instead of one JSON blob, so rules, the AI intake and TVINN work on named fields.
--
--  * A declaration belongs to a client (the partner Odin works for and invoices) and names the parties
--    in box 2 (exporter), box 8 (importer) and box 14 (declarant / representative) from the register.
--  * Statuses follow the flow: DRAFT → SUBMITTED → APPROVED → SENT → ACCEPTED | REJECTED, with RETURNED
--    (back to the specialist) and CANCELLED (never deleted). Only DRAFT and RETURNED can be changed.
--  * Box 44 documents are kept on two levels, as in ODIN LINK: shipment-wide (declaration.docs) and
--    per goods item (declaration_item.docs). Each entry: {code, ref, date?, valid?}.
--  * Amounts are exact numerics; box 42 is in the invoice currency (box 22a), box 45 parts are in NOK.

/* ---------------- reference data (data.toll.no) ---------------- */
CREATE TABLE ref_office (                    -- ekspedisjonsenhet: box A
  code        text PRIMARY KEY,              -- 6 digits
  name        text NOT NULL,
  area        text,
  direction   text,                          -- Innførsel | Utførsel | empty = both
  valid_from  date,
  valid_to    date
);

CREATE TABLE ref_procedure (                 -- prosedyrekode: box 37
  code        text PRIMARY KEY,              -- 4 digits
  text        text,
  valid_from  date,
  valid_to    date
);

CREATE TABLE ref_import_ref (                -- innfoerselsreferanse: reference codes in box 44
  code        text PRIMARY KEY,
  text        text,
  valid_from  date,
  valid_to    date
);

CREATE TABLE ref_quota (                     -- tollkvote: box 39
  doc         text PRIMARY KEY,
  landgruppe  text,
  max_qty     numeric,
  used_qty    numeric,
  unit        text,
  unit_text   text,
  codes       text[] NOT NULL DEFAULT '{}',
  valid_from  date,
  valid_to    date
);

CREATE TABLE ref_code_validity (             -- datogyldighetforvare: date changes per commodity code
  id          bigserial PRIMARY KEY,
  code        text NOT NULL,
  valid_from  date,
  valid_to    date
);
CREATE INDEX ref_code_validity_code ON ref_code_validity (code);

/* ---------------- declarations ---------------- */
CREATE SEQUENCE declaration_number START 1;

CREATE TABLE declaration (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decl_no            text NOT NULL UNIQUE
                     DEFAULT ('IMP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('declaration_number')::text, 5, '0')),
  direction          text NOT NULL DEFAULT 'IMPORT' CHECK (direction IN ('IMPORT', 'EXPORT')),
  status             text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  client_id          uuid REFERENCES business_partner(id),   -- who Odin works for
  exporter_id        uuid REFERENCES business_partner(id),   -- box 2
  importer_id        uuid REFERENCES business_partner(id),   -- box 8
  declarant_id       uuid REFERENCES business_partner(id),   -- box 14
  own_ref            text,                                   -- box 7
  decl_type          text CHECK (decl_type IN ('4', '5', '6', '7')),   -- box 1, column 2
  office             text,                                   -- box A, 6 digits
  decl_date          date,                                   -- box 54
  place              text,                                   -- box 54a
  dispatch_country   text,                                   -- box 15
  transport_id       text,                                   -- box 18
  transport_nat      text,                                   -- box 21
  container          boolean NOT NULL DEFAULT false,         -- box 19
  container_nos      text,
  transport_mode     text CHECK (transport_mode IN ('1', '2', '3', '4', '5', '7', '8', '9')),   -- box 25
  incoterms          text,                                   -- box 20
  incoterms_place    text,                                   -- box 20a
  invoice_total      numeric(16,2),                          -- box 22
  currency           text,                                   -- box 22a
  transaction_type   text,                                   -- box 24, two digits
  goods_location     text,                                   -- box 30
  prev_doc           text,                                   -- box 40
  warehouse_id       text,                                   -- box 49
  reexport_deadline  date,                                   -- temporary import (box B text)
  payment_method     text CHECK (payment_method IN ('TOLLKREDITT', 'DAGSOPPGJOR', 'KONTANT')),   -- box 48
  payment_account    text,
  docs               jsonb NOT NULL DEFAULT '[]',            -- box 44, shipment-wide
  value_details      jsonb NOT NULL DEFAULT '{}',            -- box 12 (phase 2b)
  notes              text,
  cancel_reason      text,
  created_from       text NOT NULL DEFAULT 'MANUAL',         -- MANUAL | AI | COPY
  version            integer NOT NULL DEFAULT 1,             -- row version for "changed by someone else"
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id)
);
CREATE INDEX declaration_status ON declaration (status, updated_at DESC);
CREATE INDEX declaration_client ON declaration (client_id);
CREATE INDEX declaration_importer ON declaration (importer_id);

CREATE TABLE declaration_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id    uuid NOT NULL REFERENCES declaration(id),
  line_no           integer NOT NULL,                        -- box 32
  product_id        uuid REFERENCES product(id),
  description       text,                                    -- box 31
  packages          integer,                                 -- box 31: number of packages
  package_kind      text,                                    -- box 31: kind (PK, CT, PX ...)
  marks             text,                                    -- box 31: marks and numbers
  code              text,                                    -- box 33, 8 digits
  origin            text,                                    -- box 34
  preference        text,                                    -- box 36
  procedure         text,                                    -- box 37, 4 digits
  nat_procedure     text,                                    -- box 37, national additional code
  quota             text,                                    -- box 39
  gross_kg          numeric(14,3),                           -- box 35
  net_kg            numeric(14,3),                           -- box 38
  supp_qty          numeric(14,3),                           -- box 41
  price             numeric(16,2),                           -- box 42, invoice currency
  valuation_method  text NOT NULL DEFAULT '1',               -- box 43
  freight           numeric(14,2),                           -- box 45: freight to the border, NOK
  add_amount        numeric(14,2),                           -- box 45: other additions, NOK
  ded_amount        numeric(14,2),                           -- box 45: deductions, NOK
  docs              jsonb NOT NULL DEFAULT '[]',             -- box 44, this item
  article_no        text,                                    -- as on the invoice (matching and learning)
  gtin              text,
  source            jsonb,                                   -- where each value came from (AI intake, phase 2c)
  UNIQUE (declaration_id, line_no) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX declaration_item_product ON declaration_item (product_id);

-- Box 14 and box 54a defaults for new declarations: Odin itself, found in the register by org. no.
INSERT INTO app_settings (key, value) VALUES ('declarant', '{"orgNo": "931481274", "place": ""}')
  ON CONFLICT (key) DO NOTHING;
