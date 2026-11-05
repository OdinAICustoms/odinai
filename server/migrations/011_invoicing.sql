-- 011_invoicing.sql — Odin's own invoices (phase 4a). Carried over from ODIN LINK 2.37 (src/invoicing.js,
-- migration 025), adapted: invoices follow accepted declarations instead of cases.
--
--  * The invoice basis is every accepted declaration of a client that is not on a live invoice. A
--    declaration is on at most one live invoice (invoice_declaration, unique while not released); a
--    discarded draft or a fully credited invoice releases it so it can be invoiced again.
--  * Prices come from the partner card (bp_price, the agreement on the declaration date), else the
--    price list. Each line keeps where its price came from.
--  * Box 48 decides outlays: duty and levies are recharged only when Odin paid them (Odin's own credit
--    account, dagsoppgjør or cash). Import VAT is never recharged (the importer accounts for it).
--  * A draft has no number. Issuing takes the next number from one unbroken series (invoice_counter,
--    locked in the issuing transaction), sets the KID, the due date and the PDF, and freezes the
--    invoice. A credit note takes the next number in the same series and credits whole lines; when
--    every line is credited the invoice is CREDITED and its declarations go back to the basis.
--  * Nothing is deleted: a draft is discarded, an issued invoice is credited, a draft line is removed
--    (kept with removed_at).

INSERT INTO app_settings (key, value) VALUES ('invoicing', '{
  "company": {"name": "ODIN CUSTOMS AS", "orgNo": "931481274", "vatRegistered": true, "street": "", "postalCode": "", "city": "",
              "email": "", "phone": "", "bankAccount": "", "iban": "", "bic": "", "web": ""},
  "dueDays": 14, "kid": true, "footer": ""
}') ON CONFLICT (key) DO NOTHING;

CREATE TABLE invoice_counter (
  series   text PRIMARY KEY,
  next_no  integer NOT NULL CHECK (next_no > 0)
);
INSERT INTO invoice_counter (series, next_no) VALUES ('INVOICE', 10001);

CREATE TABLE invoice (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no           integer UNIQUE,                      -- NULL while DRAFT
  kind                 text NOT NULL DEFAULT 'INVOICE' CHECK (kind IN ('INVOICE', 'CREDIT')),
  client_id            uuid NOT NULL REFERENCES business_partner(id),
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'CREDITED', 'DISCARDED')),
  issue_date           date,
  due_date             date,
  delivery_from        date,
  delivery_to          date,
  currency             text NOT NULL DEFAULT 'NOK',
  net_total            numeric(14,2) NOT NULL DEFAULT 0,    -- fees excl. VAT
  vat_total            numeric(14,2) NOT NULL DEFAULT 0,
  outlay_total         numeric(14,2) NOT NULL DEFAULT 0,    -- duty and levies paid for the client (outside VAT)
  deposit_applied      numeric(14,2) NOT NULL DEFAULT 0,
  total                numeric(14,2) NOT NULL DEFAULT 0,    -- to pay
  paid_amount          numeric(14,2) NOT NULL DEFAULT 0,    -- payments (phase 4b)
  kid                  text,
  your_ref             text,
  note                 text,
  seller               jsonb,                               -- Odin's details as printed, frozen at issue
  buyer                jsonb,                               -- the client's details as printed, frozen at issue
  credited_invoice_id  uuid REFERENCES invoice(id),         -- on a credit note: the invoice it credits
  credit_reason        text,
  document_id          uuid REFERENCES document(id),        -- the PDF made at issue
  consolidation        text NOT NULL DEFAULT 'PER_DECLARATION' CHECK (consolidation IN ('PER_DECLARATION', 'MONTHLY')),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  issued_at            timestamptz,
  issued_by            uuid REFERENCES users(id),
  CHECK (status = 'DRAFT' OR status = 'DISCARDED' OR invoice_no IS NOT NULL)
);
CREATE INDEX invoice_client ON invoice (client_id, status);
CREATE INDEX invoice_status ON invoice (status, due_date);
CREATE INDEX invoice_credits ON invoice (credited_invoice_id) WHERE credited_invoice_id IS NOT NULL;

CREATE TABLE invoice_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoice(id),
  sort            integer NOT NULL DEFAULT 0,
  line_type       text NOT NULL CHECK (line_type IN ('FEE', 'OUTLAY', 'SERVICE', 'OTHER')),
  item_code       text,                                     -- price_item code, or the outlay kind (TOLL, RT, FA, SAER, TILLEGG, UTFORSEL)
  description     text NOT NULL,
  quantity        numeric(12,3) NOT NULL,
  unit            text,
  unit_price      numeric(14,2) NOT NULL,
  amount          numeric(14,2) NOT NULL,                   -- quantity × unit price, excl. VAT
  vat_code        text NOT NULL CHECK (vat_code IN ('HIGH', 'ZERO', 'EXEMPT', 'OUTLAY')),
  vat_rate        numeric(5,2) NOT NULL,
  vat_amount      numeric(14,2) NOT NULL,
  declaration_id  uuid REFERENCES declaration(id),
  price_source    text NOT NULL CHECK (price_source IN ('AGREEMENT', 'LIST', 'CALCULATION', 'MANUAL')),
  agreed_price    numeric(14,2),                            -- the price from the agreement or list, when a person changed it
  credits_line_id uuid REFERENCES invoice_line(id),         -- on a credit note: the invoice line it credits
  removed_at      timestamptz,
  removed_by      uuid REFERENCES users(id)
);
CREATE INDEX invoice_line_invoice ON invoice_line (invoice_id, sort);
-- A line is credited once (credit notes are issued at once and never discarded).
CREATE UNIQUE INDEX invoice_line_credited_once ON invoice_line (credits_line_id) WHERE credits_line_id IS NOT NULL;

-- Which declarations an invoice covers; a declaration is on one live invoice at a time.
CREATE TABLE invoice_declaration (
  invoice_id      uuid NOT NULL REFERENCES invoice(id),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,                              -- draft discarded or invoice credited
  PRIMARY KEY (invoice_id, declaration_id)
);
CREATE UNIQUE INDEX invoice_declaration_live ON invoice_declaration (declaration_id) WHERE released_at IS NULL;

-- The PDF of an invoice lives in the document store.
ALTER TABLE document DROP CONSTRAINT document_owner_type_check;
ALTER TABLE document ADD CONSTRAINT document_owner_type_check CHECK (owner_type IN ('PRODUCT', 'RT_PERMIT', 'PARTNER', 'DECLARATION', 'INVOICE'));

-- An issued invoice is frozen: only its status (credited), payments and the PDF link may change, and
-- no invoice or line is ever deleted.
CREATE FUNCTION invoice_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invoices are never deleted'; END IF;
  IF OLD.status IN ('ISSUED', 'CREDITED') AND (
       NEW.invoice_no IS DISTINCT FROM OLD.invoice_no OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.net_total IS DISTINCT FROM OLD.net_total OR NEW.vat_total IS DISTINCT FROM OLD.vat_total
    OR NEW.outlay_total IS DISTINCT FROM OLD.outlay_total OR NEW.deposit_applied IS DISTINCT FROM OLD.deposit_applied
    OR NEW.total IS DISTINCT FROM OLD.total OR NEW.kid IS DISTINCT FROM OLD.kid OR NEW.seller IS DISTINCT FROM OLD.seller
    OR NEW.buyer IS DISTINCT FROM OLD.buyer OR NEW.your_ref IS DISTINCT FROM OLD.your_ref OR NEW.note IS DISTINCT FROM OLD.note
    OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
    OR NOT (NEW.status = OLD.status OR (OLD.status = 'ISSUED' AND NEW.status = 'CREDITED'))) THEN
    RAISE EXCEPTION 'invoice % is issued and cannot be changed; credit it instead', OLD.invoice_no;
  END IF;
  IF OLD.status = 'DISCARDED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a discarded draft cannot be reopened';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_frozen BEFORE UPDATE OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION invoice_frozen();

CREATE FUNCTION invoice_line_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invoice lines are never deleted'; END IF;
  SELECT status INTO st FROM invoice WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st <> 'DRAFT' THEN RAISE EXCEPTION 'lines of an invoice that is not a draft cannot change'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION invoice_line_frozen();
