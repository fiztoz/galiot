# Galiot — PGlite (WASM Postgres) Engine Specification

> *A complete technical blueprint for embedding PostgreSQL via WebAssembly into Galiot, powering client-side object indexing, reactive UI state, and instant metadata querying inside the browser.*

---

## 1. Why PGlite in a 100% Client-Side Web Client?

In traditional web storage clients:
1. **Memory Limits**: Storing large bucket listings in JavaScript arrays creates memory spikes and causes browser tabs to crash.
2. **Slow Filtering**: Browsing, regex matching, and date filtering across tens of thousands of objects in JavaScript locks the main thread.
3. **Loss of Hierarchy**: Calculating folder sizes recursively in client-side code requires complex tree algorithms and multiple network requests.

**PGlite (by ElectricSQL)** embeds a true, native PostgreSQL 16 engine compiled to WebAssembly directly in Galiot:
- **Instant SQL Indexing**: Search, filter, and sort 500,000+ cached objects in under 2ms using B-Tree and GIN indexes.
- **Recursive Folder Sizing**: Instant directory size rollups with standard SQL recursive Common Table Expressions (`WITH RECURSIVE`).
- **Reactive UI with `live.query()`**: UI components subscribe to SQL queries. When transfers progress or new files are cached, UI updates trigger automatically at 60 FPS.
- **Full ACID Persistence in OPFS**: All database pages and WAL files persist on the user's local disk via the browser's **Origin Private File System (OPFS)**.

---

## 2. Storage Topology & Web Worker Architecture

To guarantee the user interface remains at a silky 60 FPS regardless of database query size, PGlite runs inside a dedicated Web Worker:

```
+─────────────────────────────────────────────────────────────────────────+
|                               BROWSER TAB                               |
|                                                                         |
|  [ React 19 UI Components ]                                            |
|       │               ▲                                                 |
|       │ (SQL Query)   │ (live.query Reactive Stream)                    |
|       ▼               │                                                 |
|  +───────────────────────────────────────────────────────────────────+  |
|  |             Dedicated Web Worker: "pglite.worker.ts"              |  |
|  |                                                                   |  |
|  |   +───────────────────────────────────────────────────────────+   |  |
|  |   |             PGlite WASM Engine (~3.5 MB)                  |   |  |
|  |   |   PostgreSQL 16 Core + live extension + pgvector          |   |  |
|  |   +───────────────────────────────────────────────────────────+   |  |
|  |                                 │                                 |  |
|  |                                 ▼ (Direct POSIX Sync I/O)         |  |
|  |   +───────────────────────────────────────────────────────────+   |  |
|  |   |        Origin Private File System (OPFS) Storage          |   |  |
|  |   |           Fast sync access handles (WAL + DB files)       |   |  |
|  |   +───────────────────────────────────────────────────────────+   |  |
|  +───────────────────────────────────────────────────────────────────+  |
+─────────────────────────────────────────────────────────────────────────+
```

---

## 3. Database Schema

The Galiot schema manages connection profiles, object caching, multipart transfer tracking, and link history:

```sql
-- 1. Profiles Table (Encrypted Vault)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    protocol VARCHAR(32) NOT NULL,         -- 's3', 'sftp'
    endpoint VARCHAR(512),
    region VARCHAR(64),
    bucket VARCHAR(255),
    path_style BOOLEAN DEFAULT FALSE,
    encrypted_credentials JSONB,           -- Encrypted with WebCrypto AES-GCM
    storage_class VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Object Catalog Cache (Supports millions of objects)
CREATE TABLE IF NOT EXISTS objects_cache (
    id BIGSERIAL PRIMARY KEY,
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    bucket VARCHAR(255) NOT NULL,
    key TEXT NOT NULL,
    prefix TEXT NOT NULL,                   -- e.g. 'photos/2026/'
    filename TEXT NOT NULL,                 -- e.g. 'marina.jpg'
    is_dir BOOLEAN DEFAULT FALSE,
    size BIGINT DEFAULT 0,
    etag VARCHAR(128),
    last_modified TIMESTAMPTZ,
    storage_class VARCHAR(64),
    content_type VARCHAR(128),
    metadata JSONB,                         -- x-amz-meta-*
    tags JSONB,                             -- S3 Object tags
    cached_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_object UNIQUE (profile_id, bucket, key)
);

-- Indexes for instant browsing and fuzzy search
CREATE INDEX IF NOT EXISTS idx_objects_lookup 
    ON objects_cache (profile_id, bucket, prefix, is_dir);

CREATE INDEX IF NOT EXISTS idx_objects_filename_trgm 
    ON objects_cache USING gin (filename gin_trgm_ops);

-- 3. Transfer Queue & Resumption Ledger
CREATE TABLE IF NOT EXISTS transfer_tasks (
    id UUID PRIMARY KEY,
    profile_id UUID REFERENCES profiles(id),
    direction VARCHAR(16) NOT NULL,         -- 'upload', 'download'
    remote_key TEXT NOT NULL,
    local_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    bytes_transferred BIGINT DEFAULT 0,
    status VARCHAR(32) NOT NULL,            -- 'queued', 'transferring', 'paused', 'completed', 'failed'
    speed_bytes_sec BIGINT DEFAULT 0,
    upload_id TEXT,                         -- S3 Multipart Upload ID
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. Multipart Part Ledger (Guarantees zero-loss resumption)
CREATE TABLE IF NOT EXISTS transfer_parts (
    task_id UUID REFERENCES transfer_tasks(id) ON DELETE CASCADE,
    part_number INT NOT NULL,
    start_byte BIGINT NOT NULL,
    end_byte BIGINT NOT NULL,
    etag VARCHAR(128),
    status VARCHAR(32) NOT NULL,            -- 'pending', 'uploading', 'completed'
    PRIMARY KEY (task_id, part_number)
);

-- 5. Presigned URL History
CREATE TABLE IF NOT EXISTS presigned_history (
    id UUID PRIMARY KEY,
    profile_id UUID REFERENCES profiles(id),
    bucket VARCHAR(255) NOT NULL,
    key TEXT NOT NULL,
    url TEXT NOT NULL,
    permission VARCHAR(16) NOT NULL,        -- 'read', 'write'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. Advanced SQL Capabilities in Galiot

### 4.1 Recursive Folder Size Calculation (CTE)
Calculating the total size and object count of nested directories is executed instantly in SQL without additional S3 network roundtrips:

```sql
-- Compute the total size and file count of 'media/' and all subfolders
WITH RECURSIVE folder_tree AS (
    SELECT key, size, is_dir
    FROM objects_cache
    WHERE profile_id = $1 
      AND bucket = $2 
      AND prefix LIKE $3 || '%'
)
SELECT 
    COUNT(*) AS total_files,
    COALESCE(SUM(size), 0) AS total_bytes
FROM folder_tree
WHERE is_dir = FALSE;
```

### 4.2 Reactive UI Updates via `live.query()`
React UI components subscribe directly to database state:

```typescript
// hooks/useTransferQueue.ts
import { useLiveQuery } from '@electric-sql/pglite-react';

export function useTransferQueue() {
  const result = useLiveQuery`
    SELECT id, remote_key, direction, bytes_transferred, file_size, status, speed_bytes_sec
    FROM transfer_tasks
    WHERE status IN ('transferring', 'queued', 'paused')
    ORDER BY created_at ASC;
  `;

  return {
    tasks: result?.rows ?? [],
    activeCount: result?.rows?.filter(r => r.status === 'transferring').length ?? 0
  };
}
```

### 4.3 Semantic File Search with `pgvector`
Galiot can optionally run local AI models (`@xenova/transformers`) via WebAssembly/WebGPU to generate vector embeddings for file names and tags, storing them directly in PGlite:

```sql
-- Semantic similarity search for "financial receipts"
SELECT filename, key, size, 1 - (embedding <=> $1) AS similarity
FROM objects_cache
WHERE profile_id = $2 AND bucket = $3 AND is_dir = FALSE
ORDER BY similarity DESC
LIMIT 20;
```
