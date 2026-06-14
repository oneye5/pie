/**
 * Bridge between the subagent extension and the analytics module's
 * stratified ranker. Stateless pass-through — no caching.
 *
 * Decouples the subagent extension from the analytics module's internals.
 * The bucket selector calls this bridge; the bridge calls the stratified ranker.
 */

// Re-export shared types from the stratified ranker (single source of truth).
export type {
  BucketAssignments,
  SimpleModelConfig,
  ThinkingLevel,
} from "../../analysis/scripts/stratified-ranker.js";

// --- Public API ---

/**
 * Get current bucket assignments from the stratified ranker.
 *
 * Dynamically imports the stratified ranker from the analytics module.
 * If the analytics module is unavailable or data loading fails,
 * returns empty assignments (caller falls back to active model).
 *
 * @param analyticsDir - Path to the analytics data directory
 * @param modelConfig - Simple model config entries from model-profiles.yaml
 */
export async function getBucketAssignments(
  analyticsDir: string,
  modelConfig: SimpleModelConfig[],
): Promise<BucketAssignments> {
  try {
    // Dynamic import — the stratified ranker lives in the analytics module
    const { computeBucketAssignments } = await import(
      "../../analysis/scripts/stratified-ranker.js"
    );
    return await computeBucketAssignments(analyticsDir, modelConfig);
  } catch {
    // Analytics module unavailable or computation failed — empty = fallback
    return { small: [], medium: [], frontier: [] };
  }
}
