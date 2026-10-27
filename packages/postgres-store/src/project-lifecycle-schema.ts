/** Registration identity is independent of journal sequence and never reused.
 * Only the minimal audit survives a completed purge. */
export const PROJECT_LIFECYCLE_DDL = `
CREATE TABLE IF NOT EXISTS project_generations (
 repo text PRIMARY KEY, generation text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS project_deletions (
 repo text PRIMARY KEY, generation text NOT NULL UNIQUE,
 organization_id text, actor text NOT NULL, ts timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS project_deletion_blobs (
 repo text NOT NULL, blob_ref text NOT NULL, PRIMARY KEY (repo, blob_ref)
);
CREATE TABLE IF NOT EXISTS project_blob_ownership (
 repo text NOT NULL, blob_ref text NOT NULL, PRIMARY KEY (repo, blob_ref)
);
CREATE TABLE IF NOT EXISTS project_deletion_audit (
 repo text NOT NULL, generation text NOT NULL, actor text NOT NULL,
 ts timestamptz NOT NULL, PRIMARY KEY (repo, generation)
);
INSERT INTO project_generations (repo,generation)
 SELECT repo, gen_random_uuid()::text FROM (
 SELECT DISTINCT ON (repo) repo, action FROM project_journal ORDER BY repo, seq DESC
 ) latest ON CONFLICT DO NOTHING;
`.trim()
