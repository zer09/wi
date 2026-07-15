CREATE TABLE tool_call_occurrences (
    step_id TEXT NOT NULL REFERENCES provider_steps(step_id),
    call_id TEXT NOT NULL REFERENCES tool_executions(call_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    occurred_at_ms INTEGER NOT NULL,
    PRIMARY KEY(step_id, call_id)
) STRICT;

CREATE INDEX tool_call_occurrences_call_idx
ON tool_call_occurrences(call_id, step_id);

INSERT INTO tool_call_occurrences (step_id, call_id, run_id, occurred_at_ms)
SELECT step_id, call_id, run_id, requested_at_ms
FROM tool_executions;

UPDATE manifest
SET schema_version = 2
WHERE singleton = 1;
