import type { ModelInfo } from '../../../shared/protocol';

export interface ModelPickerEntry {
  model: ModelInfo;
  /** Display label for the dropdown <option> — prefixed with ⚠ when ineligible as subagent. */
  label: string;
  /** Compact closed-state label shown in the toolbar after selection. */
  selectedLabel: string;
  /** True for models that are explicitly ineligible as subagent targets. */
  ineligible: boolean;
  /** Tooltip text describing rating + ineligibility reason when applicable. */
  title: string;
}

const RATING_MAX = 20;

/**
 * Strip any leading provider/prefix from a model name for the compact closed-state
 * toolbar label (e.g. "Ollama Cloud: Deepseek V4 pro" → "Deepseek V4 pro").
 * The dropdown itself keeps the full provider-qualified label for disambiguation.
 */
function stripProviderPrefix(name: string): string {
  return name.replace(/^[^:]+:\s*/, '');
}

/**
 * Order models for the picker:
 *   1. Eligible / unprofiled first, then ineligible (subagent-disabled).
 *   2. Within each group, sort by aggregate subagent rating descending.
 *   3. Stable tiebreak on display name then id for deterministic UI.
 *
 * Unprofiled models keep their original relative order at the top of the eligible
 * group (they sort with aggregate=-1 fallback so a profiled eligible model ranks
 * above an unprofiled one only when its aggregate exceeds 0).
 *
 * The returned entries carry display affordances (warning prefix, tooltip) so the
 * toolbar can render without re-deriving rating logic.
 */
export function orderModelsForPicker(models: ModelInfo[]): ModelPickerEntry[] {
  const decorated = models.map((model, index) => {
    const sub = model.subagent;
    const ineligible = sub?.eligible === false;
    const aggregate = sub?.aggregate;
    return {
      model,
      index,
      ineligible,
      aggregate: typeof aggregate === 'number' ? aggregate : -1,
      hasProfile: sub !== undefined,
    };
  });

  decorated.sort((a, b) => {
    if (a.ineligible !== b.ineligible) return a.ineligible ? 1 : -1;
    if (a.aggregate !== b.aggregate) return b.aggregate - a.aggregate;
    const byName = a.model.name.localeCompare(b.model.name);
    if (byName !== 0) return byName;
    return a.model.id.localeCompare(b.model.id);
  });

  return decorated.map((entry) => {
    const { model, ineligible, aggregate, hasProfile } = entry;
    const ratingText = hasProfile && aggregate >= 0 ? `${aggregate}/${RATING_MAX}` : 'unrated';
    const prefix = ineligible ? '⚠ ' : '';

    const dropdownLabel = `${prefix}${model.name}`;
    const selectedLabel = `${prefix}${stripProviderPrefix(model.name)}`;

    const titleParts = [`${model.name} — rating ${ratingText}`];
    if (ineligible) {
      const reason = model.subagent?.disabledReason;
      titleParts.push(reason ? `Disabled for subagent use: ${reason}` : 'Disabled for subagent use');
    }
    return {
      model,
      ineligible,
      label: dropdownLabel,
      selectedLabel,
      title: titleParts.join('\n'),
    };
  });
}
