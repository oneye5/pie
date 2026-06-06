import { isRecord } from '../type-guards';

export interface SubagentTaskScoreRollup {
  precision:    { sum: number; count: number; max: number };
  creativity:   { sum: number; count: number; max: number };
  reasoning:    { sum: number; count: number; max: number };
  thoroughness: { sum: number; count: number; max: number };
}

export function createEmptySubagentTaskScoreRollup(): SubagentTaskScoreRollup {
  return {
    precision:    { sum: 0, count: 0, max: 0 },
    creativity:   { sum: 0, count: 0, max: 0 },
    reasoning:    { sum: 0, count: 0, max: 0 },
    thoroughness: { sum: 0, count: 0, max: 0 },
  };
}

export function coerceTaskScores(scores: unknown): Record<string, number> | null {
  if (!isRecord(scores)) { return null; }
  const dims = ['precision', 'creativity', 'reasoning', 'thoroughness'] as const;
  const result: Record<string, number> = {};
  let hasAny = false;
  for (const dim of dims) {
    const raw = scores[dim];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const clamped = Math.max(0, Math.min(5, Math.round(raw)));
      result[dim] = clamped;
      hasAny = true;
    }
  }
  return hasAny ? result : null;
}

export type VerificationCommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'format' | 'other';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractCommandText(input: unknown): string | null {
  if (typeof input === 'string') {
    return input.trim() ? input : null;
  }

  if (!isRecord(input)) {
    return null;
  }

  const direct = [
    input.command,
    input.cmd,
    input.script,
  ];

  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  if (Array.isArray(input.args) && input.args.every((arg) => typeof arg === 'string')) {
    const joined = input.args.join(' ').trim();
    return joined || null;
  }

  return null;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => normalizeText(segment.toLowerCase()))
    .filter((segment) => segment.length > 0);
}

function classifyVerificationSegment(segment: string): VerificationCommandKind[] {
  const kinds = new Set<VerificationCommandKind>();

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(segment)
    || /\bvitest\b/.test(segment)
    || /\bjest\b/.test(segment)
    || /\bpytest\b/.test(segment)
    || /\bgo\s+test\b/.test(segment)
    || /\bcargo\s+test\b/.test(segment)
    || /\bdotnet\s+test\b/.test(segment)
    || /\bmvn(?:w)?\s+test\b/.test(segment)
    || /\bgradle(?:w)?\s+test\b/.test(segment)
    || /\bphpunit\b/.test(segment)
    || /\brspec\b/.test(segment)
  ) {
    kinds.add('test');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b/.test(segment)
    || (/\btsc\b/.test(segment) && /--no-?emit\b/.test(segment))
    || /\bpyright\b/.test(segment)
    || /\bmypy\b/.test(segment)
    || /\bsvelte-check\b/.test(segment)
    || /\bvue-tsc\b/.test(segment)
  ) {
    kinds.add('typecheck');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/.test(segment)
    || /\beslint\b/.test(segment)
    || /\bboxlint\b/.test(segment)
    || /\bstylelint\b/.test(segment)
    || /\bmarkdownlint\b/.test(segment)
    || /\bgolangci-lint\b/.test(segment)
    || /\bcargo\s+clippy\b/.test(segment)
    || /\bflake8\b/.test(segment)
    || /\bruff\s+check\b/.test(segment)
  ) {
    kinds.add('lint');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(segment)
    || /\bvite\s+build\b/.test(segment)
    || /\bnext\s+build\b/.test(segment)
    || /\bnuxt\s+build\b/.test(segment)
    || /\bcargo\s+build\b/.test(segment)
    || /\bgo\s+build\b/.test(segment)
    || /\bdotnet\s+build\b/.test(segment)
    || /\bmvn(?:w)?\s+(?:package|install)\b/.test(segment)
    || /\bgradle(?:w)?\s+(?:build|assemble)\b/.test(segment)
    || /\bwebpack\b/.test(segment)
    || /\brollup\b/.test(segment)
    || (/\btsc\b/.test(segment) && !/--no-?emit\b/.test(segment))
  ) {
    kinds.add('build');
  }

  if (
    /\bprettier\b.*\b--check\b/.test(segment)
    || /\brustfmt\b.*\b--check\b/.test(segment)
    || /\bbiome\b.*\b(?:check|lint)\b/.test(segment)
    || /\bformat\b.*\b--check\b/.test(segment)
  ) {
    kinds.add('format');
  }

  if (
    kinds.size === 0 && (
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate)\b/.test(segment)
      || /\bcargo\s+check\b/.test(segment)
      || /\bgradle(?:w)?\s+check\b/.test(segment)
      || /\bmvn(?:w)?\s+verify\b/.test(segment)
      || /\bcheck\b/.test(segment)
      || /\bverify\b/.test(segment)
      || /\bvalidate\b/.test(segment)
    )
  ) {
    kinds.add('other');
  }

  return [...kinds];
}

export function classifyVerificationCommandKindsFromInput(input: unknown): VerificationCommandKind[] {
  const command = extractCommandText(input);
  if (!command) {
    return [];
  }

  const kinds = new Set<VerificationCommandKind>();
  for (const segment of splitCommandSegments(command)) {
    for (const kind of classifyVerificationSegment(segment)) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}

/**
 * Extract task scores from subagent result objects.
 *
 * The subagent extension stores `taskScores` on each result in
 * `result.details.results[].taskScores`, not in the tool-call input.
 * This function extracts and rolls up those per-result scores.
 */
function extractResultTaskScores(result: unknown): {
  scoredTaskCount: number;
  taskScores: SubagentTaskScoreRollup;
} | null {
  if (!isRecord(result)) { return null; }

  // The subagent extension returns { details: { mode, results: [...] } }
  // where each result may have { taskScores: { precision, ... } }
  const details = isRecord(result.details) ? result.details : null;
  if (!details) { return null; }

  const results = Array.isArray(details.results) ? details.results : null;
  if (!results || results.length === 0) { return null; }

  let scoredTaskCount = 0;
  const taskScores = createEmptySubagentTaskScoreRollup();

  for (const entry of results) {
    if (!isRecord(entry)) { continue; }
    const coerced = coerceTaskScores(entry.taskScores);
    if (coerced) {
      scoredTaskCount += 1;
      for (const dim of ['precision', 'creativity', 'reasoning', 'thoroughness'] as const) {
        const value = coerced[dim];
        if (value !== undefined) {
          taskScores[dim].sum += value;
          taskScores[dim].count += 1;
          taskScores[dim].max = Math.max(taskScores[dim].max, value);
        }
      }
    }
  }

  return scoredTaskCount > 0 ? { scoredTaskCount, taskScores } : null;
}

export function extractSubagentUsage(input: unknown, result?: unknown): {
  taskCount: number;
  agents: string[];
  scoredTaskCount: number;
  taskScores: SubagentTaskScoreRollup;
} {
  const empty = {
    taskCount: 0,
    agents: [] as string[],
    scoredTaskCount: 0,
    taskScores: createEmptySubagentTaskScoreRollup(),
  };

  if (!isRecord(input)) {
    return empty;
  }

  const taskEntries = Array.isArray(input.tasks) ? input.tasks
    : Array.isArray(input.chain) ? input.chain
    : null;

  if (taskEntries) {
    const agents = new Set<string>();
    let taskCount = 0;
    let scoredTaskCount = 0;
    const taskScores = createEmptySubagentTaskScoreRollup();
    for (const entry of taskEntries) {
      if (!isRecord(entry)) {
        continue;
      }
      if (typeof entry.task === 'string' && entry.task.trim()) {
        taskCount += 1;
      }
      if (typeof entry.agent === 'string' && entry.agent.trim()) {
        agents.add(normalizeText(entry.agent));
      }
      const coerced = coerceTaskScores(entry.taskScores);
      if (coerced) {
        scoredTaskCount += 1;
        for (const dim of ['precision', 'creativity', 'reasoning', 'thoroughness'] as const) {
          const value = coerced[dim];
          if (value !== undefined) {
            taskScores[dim].sum += value;
            taskScores[dim].count += 1;
            taskScores[dim].max = Math.max(taskScores[dim].max, value);
          }
        }
      }
    }

    // Fallback: if input didn't carry per-task scores, try the result object
    if (scoredTaskCount === 0 && result !== undefined) {
      const resultScores = extractResultTaskScores(result);
      if (resultScores) {
        scoredTaskCount = resultScores.scoredTaskCount;
        taskScores.precision = resultScores.taskScores.precision;
        taskScores.creativity = resultScores.taskScores.creativity;
        taskScores.reasoning = resultScores.taskScores.reasoning;
        taskScores.thoroughness = resultScores.taskScores.thoroughness;
      }
    }

    return { taskCount, agents: [...agents], scoredTaskCount, taskScores };
  }

  const task = typeof input.task === 'string' && input.task.trim() ? 1 : 0;
  const agents = typeof input.agent === 'string' && input.agent.trim()
    ? [normalizeText(input.agent)]
    : [];
  const coerced = coerceTaskScores(input.taskScores);
  let scoredTaskCount = 0;
  const taskScores = createEmptySubagentTaskScoreRollup();
  if (coerced) {
    scoredTaskCount = 1;
    for (const dim of ['precision', 'creativity', 'reasoning', 'thoroughness'] as const) {
      const value = coerced[dim];
      if (value !== undefined) {
        taskScores[dim].sum += value;
        taskScores[dim].count += 1;
        taskScores[dim].max = Math.max(taskScores[dim].max, value);
      }
    }
  }

  // Fallback: single-task input without taskScores — try the result object
  if (scoredTaskCount === 0 && result !== undefined) {
    const resultScores = extractResultTaskScores(result);
    if (resultScores) {
      scoredTaskCount = resultScores.scoredTaskCount;
      taskScores.precision = resultScores.taskScores.precision;
      taskScores.creativity = resultScores.taskScores.creativity;
      taskScores.reasoning = resultScores.taskScores.reasoning;
      taskScores.thoroughness = resultScores.taskScores.thoroughness;
    }
  }

  return { taskCount: task, agents, scoredTaskCount, taskScores };
}
