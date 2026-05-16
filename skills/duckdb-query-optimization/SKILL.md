---
name: duckdb-query-optimization
description: Guides DuckDB query performance tuning. Use when queries against the analytics database are slow, when writing new analytics queries, or when investigating query performance. Do not use for general SQL questions or non-DuckDB databases.
---

# DuckDB Query Optimization

## Overview

Systematic DuckDB query tuning using profiling, schema optimization, and query rewriting. The analytics system runs on DuckDB — slow queries delay insights. Every optimization is measured, not guessed.

## When to Use

- A query against the analytics database is slow (>1s for interactive, >30s for batch)
- Writing new queries that will run frequently
- Investigating why a previously fast query became slow
- Reviewing PRs that add new analytics queries
- Setting up or modifying the analytics schema

## Required Artifacts

- `analysis/queries/profile-before.md` — `EXPLAIN ANALYZE` output of the slow query before optimization
- `analysis/queries/profile-after.md` — `EXPLAIN ANALYZE` output after optimization, with timing comparison
- `analysis/queries/schema-inventory.md` — Table listing data types, constraints, and row counts for relevant tables

## The Optimization Workflow

```
1. PROFILE: Run EXPLAIN ANALYZE on the slow query
2. IDENTIFY: Find the bottleneck (scan, join, sort, aggregate)
3. HYPOTHESIZE: What change would eliminate the bottleneck?
4. MEASURE: Apply the change and re-profile
5. COMMIT: Save the optimized query and document the change
```

Never skip step 4 — guessing offers no benefit.

## How to Profile

```sql
-- Full profile with timings and cardinalities
EXPLAIN ANALYZE
SELECT ...
FROM ...
WHERE ...
GROUP BY ...;

-- Visualize the query plan (CLI only)
EXPLAIN ANALYZE SELECT ...;
```

Read the profile output bottom-up. Find the operator with the largest timing and cardinality mismatch. That's the bottleneck.

Key profile signals:
- `SEQ_SCAN` on large table → add filter/index.
- High cardinality mismatch → analyze statistics.
- `HASH_JOIN` on large build side → pre-filter or index.
- `ORDER BY` on large set → limit or index.
- `TOP_N` after full scan → pre-filter.
- Memory spill to disk → increase memory or batch.
## Schema Optimization

### Choose the Right Types

Smaller types = less I/O = faster queries:

| Prefer | Over | Reason |
|--------|------|--------|
| `TINYINT`/`SMALLINT` | `INTEGER`/`BIGINT` | If values fit (scores 1-5 = TINYINT) |
| `VARCHAR` | `BLOB`/large TEXT | Fixed-width encoding is faster unless text is massive |
| `DATE`/`TIMESTAMP` | `VARCHAR` for dates | Native date filtering and truncation |
| `ENUM` | `VARCHAR` for low-cardinality categories | Stores as 1-2 bytes, faster grouping |
| `BOOLEAN` | `TINYINT` | Semantic clarity, same storage |

### Add Constraints

```sql
-- Help the optimizer with known invariants
CREATE TABLE runs (
    id VARCHAR PRIMARY KEY,
    satisfaction TINYINT CHECK (satisfaction BETWEEN 1 AND 5),
    outcome VARCHAR CHECK (outcome IN ('success', 'partial', 'failure')),
    model VARCHAR NOT NULL,
    started_at TIMESTAMP NOT NULL
);
```

Constraints tell the optimizer what's impossible, enabling better plans. `NOT NULL` is the cheapest optimization you can add.

### Update Statistics

```sql
-- After bulk loading or significant data changes
ANALYZE runs;
ANALYZE tool_usage;
```

Statistics drive cardinality estimation. Stale statistics cause bad join ordering and suboptimal plans.

## Indexing

DuckDB's default is block-range indexes (min/max per block) — usually sufficient. Only add explicit indexes when profiling shows benefit:

```sql
-- Create after identifying the bottleneck in profiling
CREATE INDEX idx_runs_model ON runs(model);
CREATE INDEX idx_runs_started ON runs(started_at);
CREATE INDEX idx_tool_runs ON tool_usage(run_id);
```

**Don't pre-index.** Adding indexes before profiling wastes storage and write performance on indexes the optimizer never uses. Index only when `EXPLAIN ANALYZE` shows a full scan you can eliminate.

Index candidates: columns used in WHERE, JOIN, and ORDER BY on large tables (>100K rows).

## Query Optimization Patterns

### Filter Early, Aggregate Late

```sql
-- Bad: join everything, then filter
SELECT model, AVG(satisfaction)
FROM runs r
JOIN tool_usage t ON r.id = t.run_id
WHERE r.started_at > '2026-01-01'
GROUP BY model;

-- Good: filter in CTE, then join
WITH recent_runs AS (
    SELECT id, model, satisfaction
    FROM runs
    WHERE started_at > '2026-01-01'
)
SELECT model, AVG(satisfaction)
FROM recent_runs r
JOIN tool_usage t ON r.id = t.run_id
GROUP BY model;
```

The CTE forces filter pushdown and reduces the join size.

### Pre-Aggregate Before Joining

```sql
-- Bad: join individual rows, then count
SELECT r.model, COUNT(*) AS tool_calls
FROM runs r
JOIN tool_usage t ON r.id = t.run_id
GROUP BY r.model;

-- Good: pre-count, then join
WITH tool_counts AS (
    SELECT run_id, COUNT(*) AS tool_calls
    FROM tool_usage
    GROUP BY run_id
)
SELECT r.model, SUM(tc.tool_calls)
FROM runs r
JOIN tool_counts tc ON r.id = tc.run_id
GROUP BY r.model;
```

### Avoid SELECT *

```sql
-- Only scan columns you need
SELECT model, satisfaction  -- Not SELECT *
FROM runs
WHERE started_at > '2026-01-01';
```

DuckDB's columnar storage means unused columns are physically skipped — but only if you don't ask for them.

### Use WHERE Over HAVING

```sql
-- HAVING runs after aggregation — can't use indexes
SELECT model, COUNT(*)
FROM runs
GROUP BY model
HAVING COUNT(*) > 100;

-- WHERE filters before aggregation — can use indexes
-- (Can't always rewrite COUNT conditions as WHERE)
```

### Prefer BETWEEN for Date Ranges

```sql
-- BETWEEN is optimized for partition pruning
WHERE started_at BETWEEN '2026-01-01' AND '2026-01-31'

-- Over separate conditions
WHERE started_at >= '2026-01-01' AND started_at <= '2026-01-31'
```

## Configuration Tuning

```sql
-- Set per-session or in the connection
SET threads = 4;                      -- Match physical cores, not logical
SET memory_limit = '4GB';             -- 75% of available RAM
SET enable_progress_bar = false;      -- Skip for batch/automated queries
SET preserve_insertion_order = false; -- Skip sort when order doesn't matter
```

**Threads:** DuckDB parallelizes well up to physical core count. Beyond that, contention dominates. Test with 2, 4, 8 to find the sweet spot.

**Memory:** Larger memory lets DuckDB keep hash tables in RAM, avoiding disk spill. Monitor with `.timer on` and look for memory-related operators in the profile.

## File Format Choice

The analytics system likely uses `.duckdb` files. For import/export:

| Format | Best for | Reason |
|--------|----------|--------|
| `.duckdb` | Hot analytics, active queries | Native, fastest, supports all features |
| `.parquet` | Archive, sharing, cold storage | Compressed, schema-embedded, columnar |
| `.csv` | Interop, one-off imports | Universal but slow, no schema |

For large imports, prefer Parquet over CSV — 10-100x faster parsing.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It runs fine on my machine" | Test on production-scale data. |
| "DuckDB is fast enough without optimization" | Scale will expose performance limits. |
| "I'll add indexes just in case" | Indexes add overhead; profile first. |
| "SELECT * is easier" | Slower and fragile; list columns. |

## Red Flags

- Queries taking >5s against the analytics DB without profiling
- `SELECT *` in production queries
- Indexes added without `EXPLAIN ANALYZE` justification
- Schema using VARCHAR for everything (date fields, booleans, categories)
- Missing `NOT NULL` constraints where data is never null

## Verification

- [ ] `EXPLAIN ANALYZE` output captured before and after the optimization (saved to `analysis/queries/`)
- [ ] Before/after query times documented in `analysis/queries/profile-after.md`
- [ ] Schema documentation saved to `analysis/queries/schema-inventory.md`
- [ ] Schema types are appropriate (TINYINT for scores, ENUM for categories)
- [ ] Constraints reflect actual data invariants (NOT NULL, CHECK)
- [ ] Indexes exist only where profiling justified them
- [ ] Query rewritten to filter early, aggregate late, avoid SELECT *
