-- 001_foundation.sql — users, sessions, settings and the audit log.
-- Roles are a list per user; what each role may do is defined in src/auth/roles.ts.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  roles          text[] NOT NULL DEFAULT '{specialist}',
  lang           text NOT NULL DEFAULT 'no' CHECK (lang IN ('no', 'en')),
  active         boolean NOT NULL DEFAULT true,
  must_change    boolean NOT NULL DEFAULT false,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE sessions (
  id          text PRIMARY KEY,                 -- SHA-256 of the cookie value; the value itself is never stored
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES
  ('four_eyes', 'true'),
  ('default_lang', '"no"');

-- Every change is kept: who, when, from where, and field by field what changed.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users(id),
  user_name    text,
  action       text NOT NULL,
  object_type  text,
  object_id    text,
  changes      jsonb,                           -- { field: [before, after] }
  detail       jsonb,
  ip           text
);
CREATE INDEX audit_log_object ON audit_log (object_type, object_id, at DESC);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- The log can be read and added to, never changed or emptied.
CREATE FUNCTION audit_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly();
