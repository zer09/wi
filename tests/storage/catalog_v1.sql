PRAGMA application_id=1464419137;
PRAGMA user_version=1;
CREATE TABLE "catalog_meta" (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    repair_required INTEGER NOT NULL CHECK (repair_required IN (0, 1))
) STRICT;
INSERT INTO catalog_meta VALUES (1, 1, 0);
CREATE TABLE "sessions" (
    session_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    workspace_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
    schema_version INTEGER NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN ('creating', 'ready', 'missing', 'unavailable')),
    fault_code TEXT,
    last_run_id TEXT,
    last_run_state TEXT,
    seen_repair_id TEXT
) STRICT;
CREATE INDEX fixture_availability ON sessions (availability, session_id);
CREATE TABLE "creation_commands" (
    command_id TEXT PRIMARY KEY,
    payload_hash BLOB NOT NULL CHECK (length(payload_hash) = 32),
    request_json TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    creation_event_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('creating', 'accepted', 'failed')),
    receipt_json TEXT,
    failure_code TEXT
) STRICT;
INSERT INTO sessions (session_id, relative_path, title, workspace_json, created_at_ms, updated_at_ms,
                      head_sequence, schema_version, availability, fault_code)
VALUES ('ab123456-789a-4bcd-8abc-0123456789ab',
        'sessions/ab/ab123456-789a-4bcd-8abc-0123456789ab/session.sqlite3',
        'Independent fixture: Ω', '"/synthetic/nonexistent-workspace"', 100, 101, 1, 1,
        'missing', 'storage.not_found');
