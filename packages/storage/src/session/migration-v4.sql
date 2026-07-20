CREATE TABLE creation_provenance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    command_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    command_method TEXT NOT NULL CHECK (command_method = 'session.create'),
    event_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL
) STRICT;

UPDATE manifest
SET schema_version = 4
WHERE singleton = 1;
