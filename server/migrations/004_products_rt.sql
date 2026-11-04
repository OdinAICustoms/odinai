-- 004_products_rt.sql — product register, RT100 permits, and the document store.
-- Carried over from ODIN LINK 2.37 (migrations 022, 034; src/products.js, src/rt.js).
--
--  * A product belongs to a client (the owner, box 8) and may have a supplier. It holds the checked
--    classification and a status: DRAFT (suggestion only), REVIEW, CHECKED (code verified with a basis),
--    EXPIRED (valid-to passed or code gone from the tariff), BLOCKED (must not be used automatically).
--  * Every field change is in product_history; a commodity code change needs a basis.
--  * One RT decision letter (Landbruksdirektoratet) = one product. A product keeps its earlier permits
--    as history; the permit is granted to a named company (the holder) and is not transferable.

CREATE SEQUENCE product_number START 1;
CREATE SEQUENCE rt_number START 1;

CREATE TABLE product (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_no     text NOT NULL UNIQUE DEFAULT ('PRD-' || lpad(nextval('product_number')::text, 5, '0')),
  owner_id       uuid REFERENCES business_partner(id),   -- the client
  supplier_id    uuid REFERENCES business_partner(id),
  name           text NOT NULL,
  descr          text NOT NULL,                          -- goods description for box 31
  code           text,                                   -- 8 digits, no spaces
  origin         text,                                   -- ISO alpha-2
  pref_basis     text,                                   -- preference / origin basis
  supp_unit      text,                                   -- supplementary unit (box 41)
  net_kg         numeric(14,3),                          -- per unit
  gross_kg       numeric(14,3),
  price          numeric(14,2),
  currency       text,
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'CHECKED', 'EXPIRED', 'BLOCKED')),
  status_reason  text,
  basis          text CHECK (basis IN ('BKU', 'RULING', 'OTHER')),
  reference_no   text,                                   -- BKU / ruling number
  valid_to       date,
  checked_by     uuid REFERENCES users(id),
  checked_at     timestamptz,
  notes          text,
  active         boolean NOT NULL DEFAULT true,
  merged_into    uuid REFERENCES product(id),
  created_from   text NOT NULL DEFAULT 'MANUAL',         -- MANUAL | IMPORT | AI | RT | ODIN_LINK
  legacy_id      text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id)
);
CREATE INDEX product_owner ON product (owner_id);
CREATE INDEX product_status ON product (status) WHERE merged_into IS NULL;
CREATE INDEX product_code ON product (code);
CREATE UNIQUE INDEX product_legacy ON product (legacy_id) WHERE legacy_id IS NOT NULL;

-- What invoice lines are matched on: GTIN (global), the client's and the supplier's article numbers.
CREATE TABLE product_identifier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES product(id),
  type        text NOT NULL CHECK (type IN ('GTIN', 'CLIENT_ART', 'SUPPLIER_ART', 'NAME')),
  value       text NOT NULL,
  norm        text NOT NULL,                             -- upper case, no spaces/dashes/dots; GTIN digits only
  partner_id  uuid REFERENCES business_partner(id),      -- whose number it is (not for GTIN)
  source      text NOT NULL DEFAULT 'MANUAL',            -- MANUAL | IMPORT | LEARNED | AI | RT | ODIN_LINK
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_identifier_norm ON product_identifier (type, norm);
CREATE INDEX product_identifier_product ON product_identifier (product_id);
-- One article number per owner of the number; NAME (alternative names) may repeat.
CREATE UNIQUE INDEX product_identifier_unique ON product_identifier (type, norm, coalesce(partner_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE type <> 'NAME';

CREATE TABLE product_history (
  id          bigserial PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES product(id),
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  basis       text,                                      -- required for a code change
  user_id     uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_history_product ON product_history (product_id, at DESC);

-- Invoices that showed another commodity code than the checked one (work list).
CREATE TABLE product_hs_conflict (
  id            bigserial PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES product(id),
  invoice_code  text NOT NULL,
  reference     text,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rt_permit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_no      text NOT NULL UNIQUE DEFAULT ('RT-' || lpad(nextval('rt_number')::text, 5, '0')),
  product_id     uuid REFERENCES product(id),            -- NULL only for permits moved in without a match
  holder_id      uuid REFERENCES business_partner(id),   -- the company the decision is addressed to
  holder_org_no  text,                                   -- as in the decision letter (the holder check's key)
  holder_name    text,
  product_name   text NOT NULL,                          -- as in the decision letter
  tariff_code    text,
  case_ref       text,                                   -- Landbruksdirektoratet's case number
  skriv_tall     text,
  rate_tall      numeric(12,4),                          -- kr per kg, ordinary origin (TALL)
  skriv_toes     text,
  rate_toes      numeric(12,4),                          -- kr per kg, EEA origin (TOES)
  rate_unit      text NOT NULL DEFAULT 'KR_PER_KG',
  duty_code      text NOT NULL DEFAULT 'RT100',
  valid_from     date NOT NULL,
  valid_to       date NOT NULL,
  sku            text,                                   -- fallbacks from before 2.37 (lines not in the register)
  gtin           text,
  notes          text,
  active         boolean NOT NULL DEFAULT true,
  legacy_id      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX rt_permit_product ON rt_permit (product_id);
CREATE INDEX rt_permit_holder ON rt_permit (holder_id);
CREATE UNIQUE INDEX rt_permit_legacy ON rt_permit (legacy_id) WHERE legacy_id IS NOT NULL;

-- Files (BKU letters, specifications, RT decision letters, later invoices and declarations).
-- Stored once by SHA-256 under FILE_STORE, so a file cannot be altered unnoticed.
CREATE TABLE document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    text NOT NULL CHECK (owner_type IN ('PRODUCT', 'RT_PERMIT', 'PARTNER', 'DECLARATION')),
  owner_id      uuid NOT NULL,
  doc_code      text,                                    -- BKU, RT01, SPEC, N380 ...
  filename      text NOT NULL,
  mime          text,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  storage_path  text NOT NULL,
  uploaded_by   uuid REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,                             -- hidden, never deleted from disk
  removed_by    uuid REFERENCES users(id)
);
CREATE INDEX document_owner ON document (owner_type, owner_id);
