CREATE TABLE catalog_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    root_realpath TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT,
    db_relative_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('ready', 'missing', 'unavailable')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    last_event_sequence INTEGER NOT NULL DEFAULT 0,
    last_run_state TEXT,
    last_message_preview TEXT,
    requires_attention INTEGER NOT NULL DEFAULT 0,
    pending_approval_count INTEGER NOT NULL DEFAULT 0,
    pending_input_count INTEGER NOT NULL DEFAULT 0,
    session_schema_version INTEGER NOT NULL,
    recovery_candidate INTEGER NOT NULL DEFAULT 1,
    unavailable_reason TEXT
        CHECK (unavailable_reason IS NULL OR unavailable_reason = 'quarantined')
) STRICT;

CREATE INDEX sessions_updated_idx ON sessions(updated_at_ms DESC);
CREATE INDEX sessions_recovery_candidate_idx
    ON sessions(recovery_candidate, status, updated_at_ms, session_id);

CREATE TABLE catalog_commands (
    command_id TEXT PRIMARY KEY,
    command_method TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    reserved_session_id TEXT NOT NULL,
    reserved_event_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT,
    accepted_at_ms INTEGER,
    failure_code TEXT,
    failure_message TEXT,
    diagnostic_id TEXT,
    quarantined_relative_path TEXT,
    updated_at_ms INTEGER NOT NULL
) STRICT;
