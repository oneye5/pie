-- Core per-run dataset for agent inspection.
SELECT
  run_id,
  task_group_id,
  started_at,
  status,
  scored,
  resolution,
  satisfaction,
  model_id,
  thinking_level,
  experiment_assignment,
  mixed_treatment_config,
  tool_call_count,
  tool_failure_count,
  verification_total_count,
  verification_failure_count,
  busy_duration_ms,
  line_mutation_total,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  token_reported_turn_count
FROM runs
ORDER BY started_at DESC;
