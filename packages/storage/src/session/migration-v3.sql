ALTER TABLE provider_steps
ADD COLUMN diagnostic_id TEXT;

UPDATE manifest
SET schema_version = 3
WHERE singleton = 1;
