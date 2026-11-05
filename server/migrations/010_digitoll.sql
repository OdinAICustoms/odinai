-- 010_digitoll.sql — Digitoll, road (phase 3b). Carried over from ODIN LINK 2.36/2.37 (migrations 033, src/digitoll).
-- Tolletaten's advance notice of goods arriving by road (melde- og opplysningsplikt), in three messages:
-- transport (the vehicle), master consignment (the waybill) and house consignment (the goods per client).
-- The message body is kept in `data` in Tolletaten's own JSON shape, so a field or a new mode needs no
-- schema change; the columns are what lists, links and rules need.
--
--  * Every message sent and every answer received is kept in digitoll_message, which cannot be changed.
--  * After an MRN the key fields are locked (Tolletaten's rule); a change is sent as an amendment with the
--    same MRN. Cancelling needs a reason, and a master or transport with active children cannot be cancelled.
--  * A house consignment can be linked to an import declaration: the declaration ID (CUDE) is added as soon
--    as the declaration has been sent to TVINN.

CREATE TABLE digitoll_transport (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                   text NOT NULL DEFAULT 'ROAD' CHECK (mode IN ('ROAD', 'AIR', 'RAIL', 'SEA')),
  status                 text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACCEPTED', 'INCOMPLETE', 'REJECTED', 'CANCELLED')),
  data                   jsonb NOT NULL DEFAULT '{}',
  means_id               text,                   -- the vehicle's registration number
  scheduled_arrival      timestamptz,
  arrival_registered_at  timestamptz,
  mrn                    text,
  pending_change         boolean NOT NULL DEFAULT false,
  answer                 jsonb,                  -- the last answer: errors, incomplete reasons
  cancel_reason          text,
  sent_at                timestamptz,
  version                integer NOT NULL DEFAULT 1,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE digitoll_master (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id    uuid REFERENCES digitoll_transport(id),
  mode            text NOT NULL DEFAULT 'ROAD' CHECK (mode IN ('ROAD', 'AIR', 'RAIL', 'SEA')),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACCEPTED', 'INCOMPLETE', 'REJECTED', 'CANCELLED')),
  data            jsonb NOT NULL DEFAULT '{}',
  doc_number      text,
  doc_type        text,
  mrn             text,
  pending_change  boolean NOT NULL DEFAULT false,
  answer          jsonb,
  cancel_reason   text,
  sent_at         timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digitoll_master_transport ON digitoll_master (transport_id);

CREATE TABLE digitoll_house (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id         uuid REFERENCES digitoll_master(id),
  transport_id      uuid REFERENCES digitoll_transport(id),
  declaration_id    uuid REFERENCES declaration(id),
  client_id         uuid REFERENCES business_partner(id),
  mode              text NOT NULL DEFAULT 'ROAD' CHECK (mode IN ('ROAD', 'AIR', 'RAIL', 'SEA')),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACCEPTED', 'INCOMPLETE', 'REJECTED', 'CANCELLED')),
  data              jsonb NOT NULL DEFAULT '{}',
  doc_number        text,
  doc_type          text,
  import_procedure  text,
  variant           integer,                     -- the row of Tolletaten's procedure table that fits
  mrn               text,
  pending_change    boolean NOT NULL DEFAULT false,
  answer            jsonb,
  cancel_reason     text,
  sent_at           timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (master_id IS NULL OR transport_id IS NULL)   -- linked to a master or straight to a transport, not both
);
CREATE INDEX digitoll_house_master ON digitoll_house (master_id);
CREATE INDEX digitoll_house_transport ON digitoll_house (transport_id);
CREATE INDEX digitoll_house_declaration ON digitoll_house (declaration_id);

CREATE TABLE digitoll_message (
  id           bigserial PRIMARY KEY,
  object_type  text NOT NULL CHECK (object_type IN ('TRANSPORT', 'MASTER', 'HOUSE')),
  object_id    uuid NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('OUT', 'IN')),
  operation    text NOT NULL,                    -- POST (new), PUT (amendment), DELETE (cancel), ANSWER
  adapter      text NOT NULL,
  mrn          text,
  payload      jsonb,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digitoll_message_object ON digitoll_message (object_type, object_id, id);
CREATE FUNCTION digitoll_message_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'digitoll_message is insert-only'; END $$;
CREATE TRIGGER digitoll_message_no_change BEFORE UPDATE OR DELETE ON digitoll_message FOR EACH ROW EXECUTE FUNCTION digitoll_message_readonly();
CREATE TRIGGER digitoll_message_no_truncate BEFORE TRUNCATE ON digitoll_message FOR EACH STATEMENT EXECUTE FUNCTION digitoll_message_readonly();
