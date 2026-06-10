import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { runAsk } from './src/ask.js';
import { askUserSchema } from './src/types.js';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description:
      'Ask the user a clarifying question with a few preset answers and an optional free-form reply. ' +
      'Use when uncertain about intent, scope, trade-offs, or when a decision has material impact on direction. ' +
      'Prefer asking early over guessing wrong and reworking.',
    promptSnippet:
      'Ask the user a clarifying question; pauses the agent until the user picks an option or types a reply.',
    promptGuidelines: [
      'Use ask_user proactively when uncertain about intent, scope, or trade-offs — ambiguity resolved early saves rework.',
      'Prefer offering 2–4 concrete options over open-ended questions, but allow free-form when the decision needs it.',
      'Never use ask_user for status updates or to ask permission for already-described actions — just do them.',
    ],
    parameters: askUserSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runAsk(params, { ui: ctx.ui, signal });
    },
  });
}
