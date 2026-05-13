import { isRecord } from './tool-call-analysis-summary';

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
    || /\btsc\b/.test(segment) && /--no-?emit\b/.test(segment)
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
    || /\btsc\b/.test(segment) && !/--no-?emit\b/.test(segment)
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

export function extractSubagentUsage(input: unknown): { taskCount: number; agents: string[] } {
  if (!isRecord(input)) {
    return { taskCount: 0, agents: [] };
  }

  const taskEntries = Array.isArray(input.tasks) ? input.tasks
    : Array.isArray(input.chain) ? input.chain
    : null;
  if (taskEntries) {
    const agents = new Set<string>();
    let taskCount = 0;
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
    }
    return { taskCount, agents: [...agents] };
  }

  const task = typeof input.task === 'string' && input.task.trim() ? 1 : 0;
  const agents = typeof input.agent === 'string' && input.agent.trim()
    ? [normalizeText(input.agent)]
    : [];
  return { taskCount: task, agents };
}
