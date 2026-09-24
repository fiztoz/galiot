# Galiot — measured performance (Phase 5.3)

Numbers below are produced by `bun run bench`, which builds the same schema the app
uses (`runMigrations` + `pg_trgm`), seeds `objects_cache`, and times the exact
queries the explorer issues (built by `src/db/queries.ts`).

Reproduce: `bun run bench` (or `bun run bench 100000` for a single scale).
Add `GALIOT_S3_*` variables to also measure live bucket listing.

## Engine (in-process PGlite, Bun 1.4.2, Apple Silicon)

| Dataset | Seed | Ingest rate | Folder listing | Fuzzy search | Filters | Root listing | Recursive CTE |
|---|---|---|---|---|---|---|---|
| 10 000 objects | 160 ms | 62 700 obj/s | 0.2 ms | 2.4 ms | 0.2 ms | 0.1 ms | 1.2 ms |
| 100 000 objects | 1 399 ms | 71 500 obj/s | 0.1 ms | 2.8 ms | 0.1 ms | 0.1 ms | 7.5 ms |

Medians of 5 runs after a warm-up. `SELECT 1` baseline: 0.1 ms.

### Reading these numbers

- **Folder listing and filters are index-served** and stay flat at 0.1–0.2 ms
  because `objects_cache_lookup_idx (profile_id, bucket, prefix, is_dir)` is used
  directly (`Index Cond` on all three columns).
- **Fuzzy search** is the slowest path at ~2.4–2.8 ms and grows only slightly,
  which is the trigram GIN index doing its job (`filename gin_trgm_ops`).
- **The recursive CTE roll-up** grows super-linearly (1.2 ms → 7.5 ms) because it
  walks the folder hierarchy; it runs on demand, not per row.
- **These are engine-side numbers.** End-user latency in the browser is higher:
  results cross a worker boundary and are re-rendered by the live query, and
  storage goes through OPFS-AHP/IDB rather than an in-memory database.
- **Memory is not comparable across VFS backends.** The ~1 GB figure is Bun's
  in-process PGlite arena; the browser build persists through OPFS/IDB with
  different residency rules (see `docs/FEASIBILITY_AND_RISKS.md` §2).

## Listing cost against a real bucket

`GALIOT_S3_*` unset skips this section. With it set, the bench reports the time
for the first `ListObjectsV2` page and extrapolates to 500 000 keys, so the
cold-start cost of a large bucket can be compared against the cached numbers
above. Per `docs/STACK_DECISION.md` §11, listing is linear at 1 000 keys per
request, so a 500k catalog is ~500 requests — the cache is what makes search
feel instant, not the bucket.
