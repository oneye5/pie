import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { runAsk } from './src/ask.js';
import { askUserSchema } from './src/types.js';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description:
      'Ask the user a clarifying question with a few preset answers and an optional free-form reply. ' +
      'Use only for decisions you genuinely cannot make on your own (ambiguous intent, irreversible choices, ' +
      'missing key context). Do NOT use for routine progress updates.',
    promptSnippet:
      'Ask the user a clarifying question; pauses the agent until the user picks an option or types a reply.',
    promptGuidelines: [
      'Use ask_user only when you cannot reasonably proceed without a user decision.',
      'Prefer offering 2–4 concrete options over open-ended questions.',
      'Never use ask_user for status updates or to ask permission for already-described actions.',
    ],
    parameters: askUserSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runAsk(params, { ui: ctx.ui, signal });
    },
  });
}
