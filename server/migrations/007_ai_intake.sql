-- 007_ai_intake.sql — AI document intake (phase 2c).
-- Documents (invoice, packing list, export declaration, T1 ...) are stored on the declaration first; the
-- AI reads them in the background with a fixed, versioned prompt and a fixed output structure; the draft
-- is then built from the register (partners, products) before the AI's own values. Every value keeps its
-- source, and everything a person must look at becomes a review point.

-- One AI run over the documents of a declaration.
CREATE TABLE declaration_intake (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  document_ids    uuid[] NOT NULL,
  model           text,
  prompt_version  text NOT NULL,
  result          jsonb,                       -- the validated extraction, as the AI returned it
  usage           jsonb,                       -- tokens, for cost follow-up
  error           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX declaration_intake_decl ON declaration_intake (declaration_id, created_at DESC);

-- Review points: what the specialist must check or decide before the declaration can be submitted.
CREATE TABLE declaration_review (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  intake_id       uuid REFERENCES declaration_intake(id),
  line_no         integer,                     -- the goods item, when it concerns one
  kind            text NOT NULL,               -- PARTY_UNKNOWN, PRODUCT_UNMATCHED, CODE_FROM_INVOICE, LOW_CONFIDENCE, TOTALS, ...
  msg             text NOT NULL,
  data            jsonb,                       -- what the AI read (e.g. the supplier's name and address), for the action buttons
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cleared_by      uuid REFERENCES users(id),
  cleared_at      timestamptz,
  clear_note      text
);
CREATE INDEX declaration_review_decl ON declaration_review (declaration_id, status);

-- A client may refuse AI processing (Odin's terms): no document of theirs is then sent to the AI service.
ALTER TABLE business_partner ADD COLUMN ai_off boolean NOT NULL DEFAULT false;
