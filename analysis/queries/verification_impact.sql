-- Relate verification activity to outcomes. Failure attribution is run-level, not per-kind.
WITH verification_groups AS (
  SELECT
    r.run_id,
    COALESCE(v.kind, 'none') AS verification_kind,
    CASE
      WHEN v.count IS NULL OR v.count <= 0 THEN '0'
      WHEN v.count = 1 THEN '1'
      WHEN v.count <= 3 THEN '2-3'
      ELSE '4+'
    END AS count_bucket,
    r.verification_state,
    r.satisfaction,
    r.resolution
  FROM runs r
  LEFT JOIN verification_usage v
    ON v.run_id = r.run_id
)
SELECT
  verification_kind,
  count_bucket,
  verification_state,
  COUNT(DISTINCT run_id) AS run_count,
  COUNT(DISTINCT run_id) FILTER (WHERE satisfaction IS NOT NULL) AS scored_run_count,
  ROUND(AVG(satisfaction), 2) AS average_satisfaction,
  COUNT(DISTINCT run_id) FILTER (WHERE resolution = 'resolved') AS resolved_count,
  COUNT(DISTINCT run_id) FILTER (WHERE resolution = 'partially_resolved') AS partially_resolved_count,
  COUNT(DISTINCT run_id) FILTER (WHERE resolution = 'unresolved') AS unresolved_count
FROM verification_groups
GROUP BY 1, 2, 3
ORDER BY verification_kind, count_bucket, verification_state;
