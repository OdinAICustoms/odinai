-- 008_approval_tvinn.sql — submit, four-eyes approval, sending to TVINN and the answer (phase 2d).
-- Carried over from ODIN LINK 2.37 (src/sendqueue.js, src/tvinn/simulator.js, src/tvinn/edifact.js).
--
--  * Submitting freezes what is submitted: a version row with the full declaration, its goods items, the
--    calculation and the check, exactly as the approver saw it and TVINN received it. Each new submit after
--    a return or a rejection is a new version (TVINN's declaration ID ends with the version number).
--  * The approver approves (it is queued and sent) or returns it with a reason. With four eyes on
--    (app_settings.four_eyes), nobody approves a version they submitted themselves.
--  * One worker sends one version at a time. A TVINN rejection is an answer, not a failure; a transport
--    failure is retried, then left FAILED for a person (never blind retries against the real network).

CREATE TABLE declaration_version (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  version_no      integer NOT NULL,
  snapshot        jsonb NOT NULL,              -- header, items, calculation, check, as submitted
  submitted_by    uuid REFERENCES users(id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  decision        text CHECK (decision IN ('APPROVED', 'RETURNED')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_reason text,
  tvinn_id        text,                        -- <org.no>-<ddmmyyyy>-<sequence>-<version>
  message         text,                        -- the EDIFACT CUSDEC as built for this version
  result          text CHECK (result IN ('ACCEPTED', 'STAT_CHECK', 'REJECTED')),
  answer          jsonb,                       -- the answer: decision, parts, errors, raw
  mrn             text,
  tvinn_no        text,                        -- ekspedisjons- og løpenummer
  answered_at     timestamptz,
  UNIQUE (declaration_id, version_no)
);

CREATE TABLE send_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  version_id      uuid NOT NULL REFERENCES declaration_version(id),
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'DONE', 'FAILED', 'CANCELLED')),
  attempts        integer NOT NULL DEFAULT 0,
  next_try_at     timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  adapter         text NOT NULL,               -- simulator | edifact
  queued_by       uuid REFERENCES users(id),
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX send_queue_status ON send_queue (status, next_try_at);
-- One version is never in the queue twice at the same time.
CREATE UNIQUE INDEX send_queue_active ON send_queue (version_id) WHERE status IN ('QUEUED', 'SENDING');

CREATE TABLE declaration_comment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES declaration(id),
  user_id         uuid REFERENCES users(id),
  text            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX declaration_comment_decl ON declaration_comment (declaration_id, created_at);

-- The latest answer on the declaration itself, for lists and search.
ALTER TABLE declaration ADD COLUMN mrn text;
ALTER TABLE declaration ADD COLUMN tvinn_no text;
ALTER TABLE declaration ADD COLUMN current_version integer NOT NULL DEFAULT 0;
