-- Frozen schema emitted by the retained session-v3 binary at commit 1b9c4f0.
-- Do not replace this with imports from the current storage migrations.
CREATE TABLE manifest (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    session_id TEXT NOT NULL,
    project_id TEXT,
    created_at_ms INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    format_version INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    last_event_sequence INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    run_id TEXT,
    item_id TEXT,
    payload_json TEXT NOT NULL
) STRICT;

CREATE INDEX events_run_sequence_idx ON events(run_id, sequence);

CREATE TRIGGER events_forbid_update
BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'session events are immutable');
END;

CREATE TRIGGER events_forbid_delete
BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'session events are immutable');
END;

CREATE TABLE accepted_commands (
    command_id TEXT PRIMARY KEY,
    command_method TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    accepted_sequence INTEGER,
    run_id TEXT,
    result_json TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_config_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    cancelled_at_ms INTEGER,
    failure_category TEXT,
    failure_message TEXT,
    active_provider_step_id TEXT
) STRICT;

CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(run_id),
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
) STRICT;

CREATE TABLE message_parts (
    part_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(message_id),
    part_index INTEGER NOT NULL,
    part_type TEXT NOT NULL,
    text_content TEXT,
    data_json TEXT,
    UNIQUE(message_id, part_index)
) STRICT;

CREATE TABLE provider_steps (
    step_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    step_index INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    response_id TEXT,
    error_category TEXT,
    error_message TEXT, diagnostic_id TEXT,
    UNIQUE(run_id, step_index)
) STRICT;

CREATE TABLE tool_executions (
    call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    step_id TEXT NOT NULL REFERENCES provider_steps(step_id),
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    arguments_hash TEXT NOT NULL,
    effect_class TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    requested_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    result_json TEXT,
    error_json TEXT
) STRICT;

CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    call_id TEXT NOT NULL REFERENCES tool_executions(call_id),
    state TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    resolution TEXT,
    resolved_by_client_id TEXT
) STRICT;

CREATE TABLE pending_inputs (
    input_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    state TEXT NOT NULL,
    prompt TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    value_json TEXT
) STRICT;

CREATE TABLE tool_call_occurrences (
    step_id TEXT NOT NULL REFERENCES provider_steps(step_id),
    call_id TEXT NOT NULL REFERENCES tool_executions(call_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    occurred_at_ms INTEGER NOT NULL,
    PRIMARY KEY(step_id, call_id)
) STRICT;

CREATE INDEX tool_call_occurrences_call_idx
ON tool_call_occurrences(call_id, step_id);
