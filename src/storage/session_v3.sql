CREATE TABLE conversation_projection (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 format_version INTEGER NOT NULL CHECK(format_version=1),
 applied_sequence INTEGER NOT NULL CHECK(applied_sequence>=1),
 metadata_sequence INTEGER NOT NULL CHECK(metadata_sequence>=1)
) STRICT;
CREATE TABLE conversation_blocks (
 run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
 accepted_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
 changed_sequence INTEGER NOT NULL REFERENCES events(sequence),
 header_json TEXT NOT NULL
) STRICT;
CREATE INDEX conversation_blocks_changed
 ON conversation_blocks(changed_sequence,run_id);
CREATE TABLE conversation_entries (
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 entry_id TEXT NOT NULL,
 source_key BLOB NOT NULL CHECK(length(source_key)=32),
 first_sequence INTEGER NOT NULL REFERENCES events(sequence),
 position_slot INTEGER NOT NULL CHECK(position_slot>=0),
 changed_sequence INTEGER NOT NULL REFERENCES events(sequence),
 content_epoch INTEGER NOT NULL REFERENCES events(sequence),
 kind TEXT NOT NULL CHECK(kind IN('human','assistant','tool','reuse','notice')),
 metadata_json TEXT NOT NULL,
 PRIMARY KEY(run_id,entry_id),
 UNIQUE(run_id,source_key),
 UNIQUE(run_id,first_sequence,position_slot)
) STRICT;
CREATE INDEX conversation_entries_order
 ON conversation_entries(run_id,first_sequence,position_slot);
CREATE INDEX conversation_entries_changed
 ON conversation_entries(changed_sequence,run_id,entry_id);
CREATE TABLE conversation_fields (
 run_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 field_id TEXT NOT NULL,
 order_key TEXT NOT NULL,
 generation INTEGER NOT NULL REFERENCES events(sequence),
 byte_length INTEGER NOT NULL CHECK(byte_length>=0),
 kind TEXT NOT NULL,
 metadata_json TEXT NOT NULL,
 PRIMARY KEY(run_id,entry_id,field_id),
 UNIQUE(run_id,entry_id,order_key),
 FOREIGN KEY(run_id,entry_id) REFERENCES conversation_entries(run_id,entry_id)
) STRICT;
CREATE TABLE conversation_chunks (
 run_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 field_id TEXT NOT NULL,
 start_byte INTEGER NOT NULL CHECK(start_byte>=0),
 bytes BLOB NOT NULL CHECK(length(bytes)>0 AND length(bytes)<=8192),
 PRIMARY KEY(run_id,entry_id,field_id,start_byte),
 FOREIGN KEY(run_id,entry_id,field_id)
  REFERENCES conversation_fields(run_id,entry_id,field_id)
) STRICT;
