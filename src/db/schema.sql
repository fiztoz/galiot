CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('s3', 'sftp')),
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL,
    bucket TEXT NOT NULL,
    path_style BOOLEAN NOT NULL DEFAULT false,
    -- Signed requests leave from the Galiot process. `user` remains in the
    -- check so a vault from the browser-route era can be migrated to `server`.
    network TEXT NOT NULL DEFAULT 'server' CHECK (network IN ('server', 'user')),
    encrypted_credentials JSONB NOT NULL,
    storage_class TEXT,
    -- Extra headers sent on every request to this connection. Cleartext by
    -- design: credential-looking names are refused at the door (see
    -- src/s3/customHeaders.ts), so nothing secret should land here.
    custom_headers JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS objects_cache (
    id BIGSERIAL PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    prefix TEXT NOT NULL,
    filename TEXT NOT NULL,
    is_dir BOOLEAN NOT NULL DEFAULT false,
    size BIGINT NOT NULL,
    etag TEXT,
    last_modified TIMESTAMPTZ,
    storage_class TEXT,
    content_type TEXT,
    metadata JSONB,
    tags JSONB,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (profile_id, bucket, key)
);

CREATE INDEX IF NOT EXISTS objects_cache_lookup_idx ON objects_cache (profile_id, bucket, prefix, is_dir);
CREATE INDEX IF NOT EXISTS objects_cache_filename_trgm_idx ON objects_cache USING GIN (filename gin_trgm_ops);

CREATE TABLE IF NOT EXISTS transfer_tasks (
    id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
    remote_key TEXT NOT NULL,
    local_path TEXT,
    file_size BIGINT NOT NULL,
    bytes_transferred BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('queued', 'transferring', 'paused', 'completed', 'failed')),
    speed_bytes_sec BIGINT NOT NULL DEFAULT 0,
    upload_id TEXT,
    upload_fingerprint TEXT,
    target_identity TEXT,
    part_size BIGINT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_parts (
    task_id UUID NOT NULL REFERENCES transfer_tasks(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    start_byte BIGINT NOT NULL,
    end_byte BIGINT NOT NULL,
    etag TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'completed')),
    PRIMARY KEY (task_id, part_number)
);

CREATE TABLE IF NOT EXISTS presigned_history (
    id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    target_identity TEXT,
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    url TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
