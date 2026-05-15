-- Compare tool usage and failure rates. These are correlations, not causal claims.
SELECT
  tu.tool_name,
  SUM(tu.call_count) AS call_count,
  SUM(tu.failure_count) AS failure_count,
  SUM(tu.execution_failure_count) AS execution_failure_count,
  SUM(tu.verification_project_failure_count) AS verification_project_failure_count,
  SUM(tu.probe_failure_count) AS probe_failure_count,
  COUNT(DISTINCT tu.run_id) AS affected_run_count,
  ROUND(AVG(tu.satisfaction), 2) AS average_satisfaction_when_used,
  (
    SELECT ROUND(AVG(r2.satisfaction), 2)
    FROM runs r2
    WHERE r2.satisfaction IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM tool_usage tu2
        WHERE tu2.run_id = r2.run_id
          AND tu2.tool_name = tu.tool_name
      )
  ) AS average_satisfaction_when_unused
FROM tool_usage tu
GROUP BY tu.tool_name
ORDER BY call_count DESC, tool_name;
