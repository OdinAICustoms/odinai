-- 012_payments_fiken.sql — payments registered by hand, and bookkeeping in Fiken (phase 4c).
-- Bank integration (payments read from the bank) waits until OdinAi is live; until then finance registers
-- payments by hand. Every issued invoice, credit note and payment is sent to Fiken as "Annet salg"
-- (POST /sales, kind external_invoice: the invoice and its number are made outside Fiken).
--
--  * A payment is never deleted or changed: a wrong one is reversed with a reason (and undone in Fiken).
--  * fiken_sync is an outbox: one job per thing to send, worked one at a time through the adapter
--    (FIKEN_ADAPTER=simulator by default; live needs FIKEN_TOKEN in .env). A failure is retried, then
--    left FAILED for a person. fiken_link remembers Fiken's ids (contact, sale, payment).

CREATE TABLE invoice_payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES invoice(id),
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_date        date NOT NULL,
  method           text NOT NULL DEFAULT 'BANK' CHECK (method IN ('BANK', 'CASH', 'OTHER')),
  reference        text,                       -- e.g. the bank's archive reference
  note             text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  reversed_at      timestamptz,
  reversed_by      uuid REFERENCES users(id),
  reversal_reason  text
);
CREATE INDEX invoice_payment_invoice ON invoice_payment (invoice_id, paid_date);

CREATE FUNCTION invoice_payment_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payments are never deleted; reverse them'; END IF;
  IF OLD.reversed_at IS NOT NULL OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.paid_date IS DISTINCT FROM OLD.paid_date
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.method IS DISTINCT FROM OLD.method OR NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION 'a payment can only be reversed, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_payment_kept BEFORE UPDATE OR DELETE ON invoice_payment FOR EACH ROW EXECUTE FUNCTION invoice_payment_kept();

CREATE TABLE fiken_link (
  object_type  text NOT NULL CHECK (object_type IN ('CONTACT', 'SALE', 'PAYMENT')),
  object_id    uuid NOT NULL,                  -- business_partner, invoice or invoice_payment
  fiken_id     bigint NOT NULL,
  adapter      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id, adapter)
);

CREATE TABLE fiken_sync (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('SALE', 'PAYMENT', 'PAYMENT_REVERSAL', 'SETTLE')),
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  payment_id   uuid REFERENCES invoice_payment(id),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'DONE', 'FAILED', 'CANCELLED')),
  attempts     integer NOT NULL DEFAULT 0,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  adapter      text NOT NULL,
  request      jsonb,                          -- what was sent (amounts in øre, as Fiken wants)
  response     jsonb,                          -- Fiken's ids
  queued_by    uuid REFERENCES users(id),
  queued_at    timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX fiken_sync_status ON fiken_sync (status, next_try_at);
CREATE INDEX fiken_sync_invoice ON fiken_sync (invoice_id);
-- The same thing is never in the outbox twice at once.
CREATE UNIQUE INDEX fiken_sync_active ON fiken_sync (kind, invoice_id, COALESCE(payment_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('QUEUED', 'SENDING');

-- Fiken settings beside the invoicing settings (the token is never stored here: FIKEN_TOKEN in .env).
UPDATE app_settings SET value = value || '{"fiken": {"companySlug": "", "auto": true, "paymentAccount": "",
  "accounts": {"HIGH": "3000", "ZERO": "3100", "EXEMPT": "3200", "OUTLAY": "2910"},
  "vatTypes": {"HIGH": "HIGH", "ZERO": "EXEMPT", "EXEMPT": "OUTSIDE", "OUTLAY": "NONE"}}}'::jsonb
  WHERE key = 'invoicing' AND NOT (value ? 'fiken');
