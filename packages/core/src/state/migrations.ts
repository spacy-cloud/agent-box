/**
 * Versioned schema migrations. Append only: never edit a released migration,
 * add a new one. Each runs in its own `BEGIN IMMEDIATE` transaction, so several
 * processes opening a fresh database at once apply every step exactly once.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE sandboxes (
  id            TEXT PRIMARY KEY,
  host          TEXT NOT NULL,
  name          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  template      TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  backend       TEXT NOT NULL,
  isolation     TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  request_id    TEXT,
  workspace     TEXT,
  effective     TEXT,
  last_seen_at  INTEGER,
  stale         INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  removed_at    INTEGER
);
CREATE UNIQUE INDEX sandboxes_owner_request ON sandboxes(owner, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX sandboxes_host_state ON sandboxes(host, state);
CREATE INDEX sandboxes_owner ON sandboxes(owner);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  requester     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  sandbox_id    TEXT,
  request       TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  risks         TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  ttl_ms        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT,
  decision_note TEXT,
  used_at       INTEGER
);
CREATE INDEX approvals_status ON approvals(status, created_at);
CREATE INDEX approvals_lookup ON approvals(requester, request_hash, status);

CREATE TABLE audit_log (
  seq        INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  sandbox_id TEXT,
  decision   TEXT,
  details    TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX audit_log_sandbox ON audit_log(sandbox_id, seq);
CREATE INDEX audit_log_actor ON audit_log(actor, seq);
CREATE INDEX audit_log_action ON audit_log(action, seq);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed'); END;

CREATE TABLE template_trust (
  content_hash TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  trusted_by   TEXT NOT NULL,
  trusted_at   INTEGER NOT NULL
);

CREATE TABLE policy_revisions (
  rev          INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL,
  content      TEXT NOT NULL,
  actor        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE processes (
  id             TEXT PRIMARY KEY,
  sandbox_id     TEXT NOT NULL,
  command        TEXT NOT NULL,
  log_path       TEXT NOT NULL,
  pid_in_sandbox INTEGER,
  status         TEXT NOT NULL,
  exit_code      INTEGER,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
CREATE INDEX processes_sandbox ON processes(sandbox_id, started_at);

CREATE TABLE host_cache (
  host TEXT PRIMARY KEY,
  info TEXT NOT NULL,
  ok   INTEGER NOT NULL,
  ts   INTEGER NOT NULL
);

CREATE TABLE agent_tokens (
  id           TEXT PRIMARY KEY,
  context_id   TEXT NOT NULL,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
`,
  },
  {
    version: 2,
    name: 'template_pins',
    sql: `
CREATE TABLE template_pins (
  template_hash TEXT PRIMARY KEY,
  template      TEXT NOT NULL,
  backend       TEXT NOT NULL,
  pinned_base   TEXT,
  image_ref     TEXT,
  updated_at    INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'snapshots_and_network_cursor',
    sql: `
CREATE TABLE snapshots (
  sandbox_id  TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (sandbox_id, snapshot_id)
);
CREATE INDEX snapshots_sandbox ON snapshots(sandbox_id, created_at);
ALTER TABLE sandboxes ADD COLUMN net_cursor_ts INTEGER;
ALTER TABLE sandboxes ADD COLUMN net_cursor_seen INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 4,
    name: 'template_trust_snapshot',
    sql: `
ALTER TABLE template_trust ADD COLUMN name TEXT;
ALTER TABLE template_trust ADD COLUMN snapshot TEXT;
`,
  },
  {
    version: 5,
    name: 'approval_items',
    // The policy items (kind, reason, risk) behind an approval; NULL for rows written before this migration.
    sql: `
ALTER TABLE approvals ADD COLUMN items TEXT;
`,
  },
];
