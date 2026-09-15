-- Independent v1 fixture. This file does not include the production initializer.
PRAGMA application_id=1464423233;
PRAGMA user_version=1;
CREATE TABLE manifest (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 session_id TEXT NOT NULL UNIQUE,
 schema_version INTEGER NOT NULL CHECK(schema_version>0),
 format_version INTEGER NOT NULL CHECK(format_version=1),
 title TEXT NOT NULL, workspace_json TEXT,
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 head_sequence INTEGER NOT NULL CHECK(head_sequence>=0),
 creation_provenance_json TEXT NOT NULL
) STRICT;
CREATE TABLE events (
 sequence INTEGER PRIMARY KEY CHECK(sequence>0),
 event_id TEXT NOT NULL UNIQUE,
 event_type TEXT NOT NULL CHECK(event_type IN('session.created','session.renamed','run.accepted','runtime.observed','tool.result.recorded','run.result.recorded','run.interrupted')),
 event_version INTEGER NOT NULL CHECK(event_version=1),
 created_at_ms INTEGER NOT NULL,
 run_id TEXT, source_event_id TEXT, source_sequence INTEGER,
 payload_json TEXT NOT NULL,
 CHECK((event_type='runtime.observed' AND source_event_id IS NOT NULL AND source_sequence IS NOT NULL AND source_sequence>0)
 OR (event_type<>'runtime.observed' AND source_event_id IS NULL AND source_sequence IS NULL))
) STRICT;
CREATE UNIQUE INDEX fixture_source_id ON events(source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX fixture_source_sequence ON events(run_id, source_sequence) WHERE source_sequence IS NOT NULL;
CREATE INDEX fixture_run_sequence ON events(run_id, sequence);
CREATE TABLE commands (
 operation_id TEXT PRIMARY KEY, method TEXT NOT NULL,
 payload_hash BLOB NOT NULL CHECK(length(payload_hash)=32),
 first_sequence INTEGER NOT NULL REFERENCES events(sequence),
 last_sequence INTEGER NOT NULL REFERENCES events(sequence),
 receipt_json TEXT NOT NULL, CHECK(last_sequence>=first_sequence)
) STRICT;
CREATE TABLE runs (
 run_id TEXT PRIMARY KEY,
 accepted_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
 state TEXT NOT NULL CHECK(state IN('accepted','running','completed','failed','cancelled_locally','interrupted')),
 last_runtime_sequence INTEGER NOT NULL CHECK(last_runtime_sequence>=0),
 owner_instance_id TEXT NOT NULL, provider_session_id TEXT,
 terminal_sequence INTEGER REFERENCES events(sequence), terminal_json TEXT,
 result_sequence INTEGER REFERENCES events(sequence)
) STRICT;
CREATE UNIQUE INDEX fixture_unfinished ON runs((1)) WHERE state IN('accepted','running');
CREATE TABLE tool_results (
 run_id TEXT NOT NULL REFERENCES runs(run_id), call_id TEXT NOT NULL,
 tool_name TEXT NOT NULL, request_id TEXT,
 started_sequence INTEGER NOT NULL REFERENCES events(sequence),
 finished_sequence INTEGER REFERENCES events(sequence),
 result_sequence INTEGER REFERENCES events(sequence),
 is_error INTEGER CHECK(is_error IN(0,1)), output TEXT,
 PRIMARY KEY(run_id,call_id),
 CHECK((result_sequence IS NULL AND output IS NULL) OR (result_sequence IS NOT NULL AND output IS NOT NULL))
) STRICT;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands
 BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands
 BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER manifest_creation_immutable BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest
 BEGIN SELECT RAISE(ABORT,'immutable session identity'); END;
