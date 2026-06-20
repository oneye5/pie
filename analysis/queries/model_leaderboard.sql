-- Model leaderboard with expected-strength composite ranking.
-- Groups by model + thinking level (experiment assignments collapsed).
-- The authoritative composite is computed in TS (scripts/leaderboard.ts) using empirical-Bayes
-- shrunk point estimates; this query mirrors the per-dimension display values only.
SELECT
  COALESCE(model_id, '(unknown)') AS model_id,
  COALESCE(thinking_level, '(unspecified)') AS thinking_level,
  COUNT(*) AS run_count,
  COUNT(*) FILTER (WHERE scored = TRUE AND satisfaction IS NOT NULL) AS scored_run_count,
  ROUND(AVG(satisfaction), 2) AS avg_satisfaction,
  ROUND(
    (AVG(CASE resolution
      WHEN 'resolved' THEN 1.0
      WHEN 'partially_resolved' THEN 0.5
      ELSE 0.0
    END) FILTER (WHERE scored = TRUE)), 3
  ) AS resolution_rate,
  ROUND(AVG(CASE WHEN first_attempt_success THEN 1.0 ELSE 0.0 END), 3) AS first_attempt_success_rate,
  ROUND(AVG(CASE WHEN tool_failure_count = 0 THEN 1.0 ELSE 0.0 END), 3) AS tool_reliability_rate,
  ROUND(AVG(CASE WHEN verification_total_count > 0 AND verification_state = 'passing' THEN 1.0 WHEN verification_total_count > 0 THEN 0.0 END), 3) AS verification_pass_rate,
  CAST(QUANTILE_CONT(busy_duration_ms, 0.5) AS BIGINT) AS median_duration_ms,
  ROUND(QUANTILE_CONT(token_efficiency, 0.5), 3) AS median_token_efficiency,
  COUNT(*) FILTER (WHERE subagent_call_count > 0) AS subagent_run_count,
  ROUND(AVG(CASE WHEN subagent_call_count > 0 THEN 1.0 ELSE 0.0 END), 3) AS subagent_usage_rate,
  COUNT(*) FILTER (WHERE resolution = 'resolved') AS resolved_count,
  COUNT(*) FILTER (WHERE resolution = 'partially_resolved') AS partially_resolved_count,
  COUNT(*) FILTER (WHERE resolution = 'unresolved') AS unresolved_count
FROM runs
WHERE status <> 'open'
GROUP BY 1, 2
ORDER BY scored_run_count DESC, model_id, thinking_level;
