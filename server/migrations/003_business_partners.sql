-- 003_business_partners.sql — the Business Partner register.
-- One record per company or person; everything that changes over time (addresses, roles,
-- identifiers, contacts, links, authorisations, credit accounts, prices) is a dated child row,
-- ended rather than deleted, so a declaration can always be explained as it was on its date.
-- Rules: src/partners/rules.ts. Model carried over from ODIN LINK 2.37 (migrations 009–016, 025).

CREATE SEQUENCE bp_number START 1;

CREATE TABLE business_partner (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_no            text NOT NULL UNIQUE DEFAULT ('BP-' || lpad(nextval('bp_number')::text, 5, '0')),
  category              text NOT NULL DEFAULT 'ORGANIZATION' CHECK (category IN ('ORGANIZATION', 'PERSON')),
  legal_name            text NOT NULL,
  search_name           text NOT NULL,             -- upper case, punctuation removed; not unique
  registration_country  text NOT NULL DEFAULT 'NO',
  language              text NOT NULL DEFAULT 'NO',
  is_client             boolean NOT NULL DEFAULT false,   -- a client of ODIN CUSTOMS AS
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  merged_into           uuid REFERENCES business_partner(id),
  notes                 text,
  default_incoterms     text,
  default_incoterms_place text,
  deposit_paid          boolean NOT NULL DEFAULT false,
  deposit_amount        numeric(14,2),
  deposit_date          date,
  source                text NOT NULL DEFAULT 'MANUAL',   -- MANUAL | BRREG | ODIN_LINK
  legacy_id             text,                              -- the id in ODIN LINK, for the move
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id)
);
CREATE INDEX bp_search ON business_partner (search_name);
CREATE INDEX bp_status ON business_partner (status, is_client);
CREATE UNIQUE INDEX bp_legacy ON business_partner (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE bp_address (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES business_partner(id),
  address_type   text NOT NULL,          -- REGISTERED POSTAL DELIVERY WAREHOUSE GOODS_LOCATION CORRESPONDENCE INVOICE
  address_name   text,
  street         text,
  postal_code    text,
  city           text,
  region         text,
  country_code   text NOT NULL,
  location_code  text,                   -- goods location (box 30 / 49)
  is_standard    boolean NOT NULL DEFAULT false,
  valid_from     date,
  valid_to       date,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED'))
);
CREATE INDEX bp_address_partner ON bp_address (partner_id);

CREATE TABLE bp_identifier (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES business_partner(id),
  identifier_type   text NOT NULL,       -- ORG_NO PERSON_NO VAT_NO EORI NODI_ID PROTERIA_NO EXTERNAL_ID
  identifier_value  text NOT NULL,
  issuing_country   text,
  is_primary        boolean NOT NULL DEFAULT false,
  valid_from        date,
  valid_to          date,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  source            text,                -- MANUAL | BRREG | ODIN_LINK
  check_status      text,                -- VALID | INVALID | NOT_APPLICABLE (EU EORI service)
  check_name        text,
  check_address     text,
  checked_at        timestamptz,
  check_error       text
);
CREATE INDEX bp_identifier_partner ON bp_identifier (partner_id);
CREATE INDEX bp_identifier_value ON bp_identifier (identifier_type, replace(identifier_value, ' ', ''));

CREATE TABLE bp_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES business_partner(id),
  role_code   text NOT NULL,             -- IMP CON EXP CNR DEC REP DEB PTH WHL CAR SUP
  valid_from  date,
  valid_to    date,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  notes       text
);
CREATE INDEX bp_role_partner ON bp_role (partner_id, role_code);

CREATE TABLE bp_contact (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         uuid NOT NULL REFERENCES business_partner(id),
  contact_type       text NOT NULL DEFAULT 'GENERAL',   -- CUSTOMS GENERAL FINANCE
  contact_name       text,
  department         text,
  email              text,
  telephone          text,
  is_primary         boolean NOT NULL DEFAULT false,
  clearance_mail     boolean NOT NULL DEFAULT false,    -- gets the approved declaration by e-mail
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED'))
);
CREATE INDEX bp_contact_partner ON bp_contact (partner_id);

CREATE TABLE bp_relationship (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_partner_id  uuid NOT NULL REFERENCES business_partner(id),
  target_partner_id  uuid NOT NULL REFERENCES business_partner(id),
  relationship_type  text NOT NULL,      -- PARENT_OF SUBSIDIARY_OF GOODS_STORED_BY BROKER_FOR OTHER
  valid_from         date,
  valid_to           date,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  notes              text,
  CHECK (source_partner_id <> target_partner_id)
);
CREATE INDEX bp_relationship_source ON bp_relationship (source_partner_id);
CREATE INDEX bp_relationship_target ON bp_relationship (target_partner_id);

-- Fullmakt: the representative (box 14) may act for the partner (box 8 / 2).
CREATE TABLE bp_fullmakt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         uuid NOT NULL REFERENCES business_partner(id),
  representative_id  uuid NOT NULL REFERENCES business_partner(id),
  representation     text NOT NULL DEFAULT 'DIRECT' CHECK (representation IN ('DIRECT', 'INDIRECT')),
  scope              text NOT NULL DEFAULT 'IMPORT_EXPORT' CHECK (scope IN ('IMPORT', 'EXPORT', 'IMPORT_EXPORT')),
  valid_from         date NOT NULL,
  valid_to           date,
  document_ref       text,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (partner_id <> representative_id)
);
CREATE INDEX bp_fullmakt_partner ON bp_fullmakt (partner_id, representative_id);

-- Tollkreditt / dagsoppgjør accounts (box 48).
CREATE TABLE bp_credit_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES business_partner(id),
  account       text NOT NULL,
  payment_type  text NOT NULL DEFAULT 'TOLLKREDITT' CHECK (payment_type IN ('TOLLKREDITT', 'DAGSOPPGJOR')),
  valid_to      date,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED'))
);
CREATE UNIQUE INDEX bp_credit_account_no ON bp_credit_account (account) WHERE status = 'ACTIVE';

-- Brønnøysund (Enhetsregisteret) data per linked partner; role holders by name only, never birth dates.
CREATE TABLE bp_registry (
  partner_id          uuid PRIMARY KEY REFERENCES business_partner(id),
  org_no              text NOT NULL,
  vat_registered      boolean,
  bankrupt            boolean,
  winding_up          boolean,
  forced_dissolution  boolean,
  deleted             boolean,
  data                jsonb NOT NULL,
  roles               jsonb,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  fetch_error         text
);

-- Odin's services and the price list; each client's agreed prices are locked on the partner card.
CREATE TABLE price_item (
  code        text PRIMARY KEY,
  name_no     text NOT NULL,
  name_en     text,
  unit        text NOT NULL CHECK (unit IN ('PER_DECL', 'PER_LINE', 'PER_HOUR', 'FIXED', 'PERCENT_DUTY')),
  price       numeric(12,2) NOT NULL DEFAULT 0,     -- list price excl. VAT
  free_lines  integer,                              -- PER_LINE: lines included before charging
  applies_to  text NOT NULL DEFAULT 'ALL' CHECK (applies_to IN ('ALL', 'IMPORT', 'EXPORT', 'SERVICE')),
  mva_code    text NOT NULL DEFAULT 'HIGH' CHECK (mva_code IN ('HIGH', 'ZERO', 'EXEMPT', 'OUTLAY')),
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 100
);
INSERT INTO price_item (code, name_no, name_en, unit, price, free_lines, applies_to, mva_code, sort) VALUES
  ('DECL_IMP',   'Fortolling innførsel',              'Import clearance',            'PER_DECL', 0, NULL, 'IMPORT',  'HIGH', 10),
  ('DECL_EXP',   'Utførselsdeklarasjon',              'Export declaration',          'PER_DECL', 0, NULL, 'EXPORT',  'HIGH', 20),
  ('EXTRA_LINE', 'Tillegg per varepost',              'Additional goods item',       'PER_LINE', 0, 5,    'ALL',     'HIGH', 30),
  ('HOUR',       'Timer',                             'Hours',                       'PER_HOUR', 0, NULL, 'SERVICE', 'HIGH', 40),
  ('CREDIT_FEE', 'Kredittprovisjon (av toll/avgift)', 'Credit commission (of duty)', 'PERCENT_DUTY', 0, NULL, 'IMPORT', 'HIGH', 50);

-- A client's price for one item from a date. A locked agreement is never edited: a new price is a
-- new row from a later date, so every invoice can be explained with the price that applied.
CREATE TABLE bp_price (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES business_partner(id),
  item_code   text NOT NULL REFERENCES price_item(code),
  price       numeric(12,2) NOT NULL,
  free_lines  integer,
  valid_from  date NOT NULL,
  valid_to    date,
  locked_at   timestamptz NOT NULL DEFAULT now(),
  locked_by   uuid REFERENCES users(id),
  note        text,
  UNIQUE (partner_id, item_code, valid_from)
);

CREATE TABLE bp_invoicing (
  partner_id     uuid PRIMARY KEY REFERENCES business_partner(id),
  consolidation  text NOT NULL DEFAULT 'PER_DECLARATION' CHECK (consolidation IN ('PER_DECLARATION', 'MONTHLY')),
  due_days       integer NOT NULL DEFAULT 14,
  invoice_email  text,
  ehf            boolean NOT NULL DEFAULT false,      -- send as EHF (Peppol) instead of PDF
  notes          text
);
