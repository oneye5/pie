import type { AskUserInput } from './types.js';
import { CUSTOM_SENTINEL } from './types.js';

export interface AskPort {
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
  };
  signal?: AbortSignal;
}

type AskResult = ReturnType<typeof answered> | ReturnType<typeof cancelled>;

export async function runAsk(input: AskUserInput, port: AskPort): Promise<AskResult> {
  const presetOptions = input.options.filter((option) => option !== CUSTOM_SENTINEL);
  const allowCustom = input.allowCustom !== false || presetOptions.length === 0;
  const title = input.context ? `${input.question}\n\n${input.context}` : input.question;
  const selectOptions = [...presetOptions];
  if (allowCustom) {
    selectOptions.push(CUSTOM_SENTINEL);
  }

  const picked = await port.ui.select(title, selectOptions, { signal: port.signal });
  if (picked === undefined) {
    return cancelled();
  }

  if (picked !== CUSTOM_SENTINEL) {
    const source = presetOptions.includes(picked) ? 'option' : 'custom';
    return answered(picked, source);
  }

  const custom = await port.ui.input('Your answer', undefined, { signal: port.signal });
  if (!custom?.trim()) {
    return cancelled();
  }

  return answered(custom.trim(), 'custom');
}

function answered(answer: string, source: 'option' | 'custom') {
  return {
    content: [{ type: 'text' as const, text: answer }],
    details: { answer, source, cancelled: false },
    isError: false as const,
  };
}

function cancelled() {
  return {
    content: [{ type: 'text' as const, text: '[user cancelled the question]' }],
    details: { answer: '', source: 'cancelled' as const, cancelled: true },
    isError: false as const,
  };
}
