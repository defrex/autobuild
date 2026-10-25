-- Experiment-owned: explicitly apply only to the experiment database.
-- Never alter ab_schema_migrations or the shared product schema.
BEGIN;
CREATE SCHEMA IF NOT EXISTS proa_oauth;
CREATE TABLE IF NOT EXISTS proa_oauth.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version = 1),
  document jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO proa_oauth.state(singleton,version) VALUES(true,1) ON CONFLICT DO NOTHING;
COMMIT;
