import type { ChatMessage, ModelInfo, SessionSummary, ToolCall, ViewState } from '../../shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../../shared/protocol';
import { CUSTOM_SENTINEL } from '../../shared/ask-user-sentinel';
import { EMPTY_VIEW_STATE } from './hooks/use-host-sync';

export interface DevFixture {
  id: string;
  label: string;
  state: ViewState;
}

const now = '2026-06-02T12:00:00.000Z';
const primaryPath = '/workspace/.pie/sessions/refined-ui.jsonl';
const reviewPath = '/workspace/.pie/sessions/review-pricing-plan.jsonl';

const sessions: SessionSummary[] = [
  {
    path: primaryPath,
    name: 'Refine webview browser mode',
    cwd: '/workspace/pi-config',
    modifiedAt: now,
    messageCount: 6,
    modelId: 'gpt-5.4-mini',
    thinkingLevel: 'medium',
  },
  {
    path: reviewPath,
    name: 'Review pricing plan',
    cwd: '/workspace/pi-config',
    modifiedAt: '2026-06-02T11:46:00.000Z',
    messageCount: 3,
    modelId: 'claude-sonnet-4.5',
    thinkingLevel: 'low',
  },
];

const availableModels: ModelInfo[] = [
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini',
    provider: 'github-copilot',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 8192,
    subagent: { eligible: true, aggregate: 17, normalizedCost: 4 },
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    subagent: { eligible: true, aggregate: 18, normalizedCost: 8 },
  },
  {
    id: 'local-fast-code',
    name: 'Local Fast Code',
    provider: 'ollama',
    reasoning: false,
    inputKinds: ['text'],
    contextWindow: 32000,
    maxTokens: 4096,
    subagent: { eligible: false, aggregate: 9, disabledReason: 'Lower reliability on delegated edits' },
  },
];

const completedTool: ToolCall = {
  id: 'tool-read-1',
  name: 'read_file',
  input: {
    filePath: '/workspace/pi-config/extension/src/webview/panel/app.tsx',
    startLine: 1,
    endLine: 120,
  },
  result: {
    content: [{ type: 'text', text: 'Read 120 lines from app.tsx.' }],
  },
  status: 'completed',
  startedAt: Date.parse(now) - 4200,
  durationMs: 713,
};

const runningTool: ToolCall = {
  id: 'tool-test-1',
  name: 'run_in_terminal',
  input: {
    command: 'npm --prefix extension run build -- --skip-typecheck -- --no-sync',
    goal: 'Build browser webview dev artifacts',
  },
  status: 'running',
  startedAt: Date.parse(now) - 1800,
};

const askUserRunningTool: ToolCall = {
  id: 'tool-ask-1',
  name: 'ask_user',
  input: {
    question: 'Which naming convention should we use for the new API endpoints?',
    options: ['camelCase', 'snake_case', 'kebab-case'],
    allowCustom: true,
    context: 'The existing codebase uses a mix of styles; a consistent choice reduces cognitive load for all contributors.',
  },
  status: 'running',
  startedAt: Date.parse(now) - 800,
};

const askUserCompletedTool: ToolCall = {
  id: 'tool-ask-2',
  name: 'ask_user',
  input: {
    question: 'Should we keep backwards compatibility?',
    options: ['Yes, keep v1 compat', 'No, break v1'],
    allowCustom: false,
  },
  result: {
    content: [{ type: 'text', text: 'Yes, keep v1 compat' }],
    details: { answer: 'Yes, keep v1 compat', source: 'option', cancelled: false },
  },
  status: 'completed',
  startedAt: Date.parse(now) - 5000,
  durationMs: 3200,
};

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: now,
    markdown,
    status: 'completed',
  };
}

function assistantMessage(id: string, markdown: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: now,
    markdown,
    parts: [{ kind: 'text', text: markdown }],
    modelId: 'gpt-5.4-mini',
    thinkingLevel: 'medium',
    status: 'completed',
    durationMs: 4200,
    usage: {
      inputTokens: 1820,
      outputTokens: 640,
      cacheReadTokens: 2048,
      cacheWriteTokens: 0,
      totalTokens: 4508,
    },
    ...overrides,
  };
}

function transcriptWindowFor(transcript: ChatMessage[]) {
  return {
    ...EMPTY_TRANSCRIPT_WINDOW,
    totalCount: transcript.length,
    loadedEnd: transcript.length,
    hasUserMessages: transcript.some((message) => message.role === 'user'),
  };
}

function baseState(overrides: Partial<ViewState> = {}): ViewState {
  const transcript = overrides.transcript ?? [];

  return {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    sessions,
    openTabPaths: [primaryPath, reviewPath],
    activeSession: sessions[0],
    transcript,
    transcriptWindow: overrides.transcriptWindow ?? transcriptWindowFor(transcript),
    transcriptLoaded: true,
    workspaceCwd: '/workspace/pi-config',
    systemPrompts: [
      {
        source: 'harness',
        title: 'Harness prompt',
        text: 'You are running in browser webview dev mode with a canned host state.',
        summary: 'Browser dev host prompt',
        availability: 'available',
      },
      {
        source: 'user',
        title: 'Repository instructions',
        text: 'Use the existing panel UI patterns, keep controls compact, and verify visual behavior.',
        summary: 'Repo UI rules',
        availability: 'available',
      },
    ],
    modelSettings: { defaultModel: 'gpt-5.4-mini', defaultThinkingLevel: 'medium' },
    availableModels,
    contextUsage: { tokens: 28640, contextWindow: 128000, percent: 22.4 },
    availableExtensions: [
      { id: 'subagent', label: 'Subagent', description: 'Delegate focused tasks to isolated agents.' },
      { id: 'skill-pruner', label: 'Skill pruner', description: 'Select only the skills relevant to a prompt.' },
      { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous operations before they run.' },
    ],
    pruningCatalog: {
      skills: ['frontend-design', 'test-authoring', 'verification-before-completion', 'systematic-debugging'],
      tools: ['read_file', 'grep_search', 'apply_patch', 'run_in_terminal', 'run_playwright_code'],
    },
    pruningResult: {
      skillsKept: 3,
      skillsTotal: 18,
      toolsKept: 9,
      toolsTotal: 64,
      tokensSaved: 18420,
      hasSkillPruning: true,
      hasToolPruning: true,
    },
    activeRunSummary: {
      runId: 'dev-run-1',
      status: 'open',
      scored: false,
    },
    ...overrides,
  };
}

const normalTranscript = [
  userMessage('user-1', 'Can we make the VS Code extension UI easier to inspect without constantly reopening VS Code?'),
  assistantMessage('assistant-1', 'Yes. The webview can run as a browser app with a tiny host shim, while the actual extension keeps using the VS Code entrypoint.'),
  userMessage('user-2', 'I care most about catching obvious layout issues before an agent hands work back.'),
  assistantMessage('assistant-2', 'That is exactly where browser mode helps: narrow widths, themes, long content, tool calls, attachments, and modal states can all be inspected from URL-selected fixtures.'),
];

const toolTranscript = [
  ...normalTranscript,
  assistantMessage('assistant-tools', 'I checked the webview seams and build pipeline.', {
    parts: [
      { kind: 'text', text: 'I checked the webview seams and build pipeline.' },
      { kind: 'toolCall', toolCall: completedTool },
      { kind: 'toolCall', toolCall: runningTool },
    ],
    toolCalls: [completedTool, runningTool],
    status: 'streaming',
  }),
];

const longTranscript = [
  userMessage('user-long', 'Stress the sidebar width with a long code-oriented explanation and a very long file path.'),
  assistantMessage(
    'assistant-long',
    [
      'The browser fixture deliberately includes long words and paths so the panel has to prove it can wrap cleanly instead of growing sideways.',
      '',
      '`d:/Projects/StandAloneProjects/pi-config/extension/src/webview/panel/transcript/rows/message-row.tsx` should stay readable without forcing horizontal scroll.',
      '',
      'A compact sidebar should keep the transcript, file-change summary, model picker, and composer controls stable at narrow widths. This paragraph is intentionally wordy enough to expose cramped spacing, clipped controls, and awkward line breaks.',
    ].join('\n'),
  ),
];

export const devFixtures: DevFixture[] = [
  {
    id: 'loading',
    label: 'Loading',
    state: { ...EMPTY_VIEW_STATE },
  },
  {
    id: 'empty',
    label: 'Empty',
    state: baseState({ sessions: [], openTabPaths: [], activeSession: null, transcript: [], transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW } }),
  },
  {
    id: 'chat',
    label: 'Normal chat',
    state: baseState({ transcript: normalTranscript }),
  },
  {
    id: 'busy',
    label: 'Busy streaming',
    state: baseState({
      transcript: toolTranscript,
      busy: true,
      runningSessionPaths: [primaryPath],
    }),
  },
  {
    id: 'tools',
    label: 'Tool calls',
    state: baseState({ transcript: toolTranscript }),
  },
  {
    id: 'long',
    label: 'Long content',
    state: baseState({ transcript: longTranscript }),
  },
  {
    id: 'attachments',
    label: 'Attachments',
    state: baseState({
      transcript: normalTranscript,
      pendingComposerInputs: [
        {
          id: 'input-path-1',
          kind: 'filesystemPathRef',
          path: '/workspace/pi-config/extension/src/webview/panel/styles/index.css',
          name: 'index.css',
          source: 'picker',
        },
        {
          id: 'input-image-1',
          kind: 'imageBlob',
          mimeType: 'image/png',
          name: 'sidebar-reference.png',
          sizeBytes: 2784,
          dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWQ6wAAAABJRU5ErkJggg==',
          width: 1280,
          height: 720,
          source: 'paste',
        },
      ],
    }),
  },
  {
    id: 'error',
    label: 'Error notice',
    state: baseState({
      transcript: normalTranscript,
      notice: 'Error: backend restart failed while restoring a retained sidebar webview. This long notice should wrap and expose the More action cleanly without covering the tab strip or composer.',
    }),
  },
  {
    id: 'files',
    label: 'File changes',
    state: baseState({
      transcript: normalTranscript,
      fileChanges: [
        {
          path: '/workspace/pi-config/extension/src/webview/panel/dev.tsx',
          kind: 'created',
          toolCallId: 'tool-edit-1',
          messageId: 'assistant-2',
          description: 'Added browser-mode entrypoint.',
          timestamp: now,
          additions: 188,
          deletions: 0,
        },
        {
          path: '/workspace/pi-config/extension/scripts/build.mjs',
          kind: 'modified',
          toolCallId: 'tool-edit-1',
          messageId: 'assistant-2',
          description: 'Included browser dev bundle in webview builds.',
          timestamp: now,
          additions: 32,
          deletions: 4,
        },
      ],
    }),
  },
  {
    id: 'outcome',
    label: 'Outcome dialog',
    state: baseState({
      transcript: normalTranscript,
      showOutcomeDialog: true,
    }),
  },
  {
    id: 'extension-ui',
    label: 'Extension confirm',
    state: baseState({
      transcript: normalTranscript,
      pendingExtensionUIRequest: {
        id: 'confirm-1',
        method: 'confirm',
        title: 'Safeguard confirmation',
        message: 'Allow the dev host to simulate this extension UI request?',
        extensionId: 'safeguard',
      },
    }),
  },
  {
    id: 'extension-ui-select',
    label: 'Extension select',
    state: baseState({
      transcript: normalTranscript,
      pendingExtensionUIRequest: {
        id: 'select-1',
        method: 'select',
        title: 'How should we proceed?',
        options: ['Run full suite', 'Run fast checks only', 'Skip tests'],
        extensionId: 'safeguard',
      },
    }),
  },
  {
    id: 'extension-ui-input',
    label: 'Extension input',
    state: baseState({
      transcript: normalTranscript,
      pendingExtensionUIRequest: {
        id: 'input-1',
        method: 'input',
        title: 'Branch name',
        placeholder: 'e.g. feature/my-branch',
        extensionId: 'subagent',
      },
    }),
  },
  {
    id: 'ask-user-running',
    label: 'Ask user (running)',
    state: baseState({
      transcript: [
        ...normalTranscript,
        assistantMessage('assistant-ask-running', 'I need to know your preference before continuing.', {
          parts: [
            { kind: 'text', text: 'I need to know your preference before continuing.' },
            { kind: 'toolCall', toolCall: askUserRunningTool },
          ],
          toolCalls: [askUserRunningTool],
          status: 'streaming',
        }),
      ],
      pendingExtensionUIRequest: {
        id: 'ext-ui-ask-1',
        method: 'select',
        title: 'Which naming convention should we use for the new API endpoints?\n\nThe existing codebase uses a mix of styles; a consistent choice reduces cognitive load for all contributors.',
        options: ['camelCase', 'snake_case', 'kebab-case', CUSTOM_SENTINEL],
      },
      busy: true,
    }),
  },
  {
    id: 'ask-user-completed',
    label: 'Ask user (completed)',
    state: baseState({
      transcript: [
        ...normalTranscript,
        assistantMessage('assistant-ask-completed', 'Got it. I\u2019ll use the naming convention you selected.', {
          parts: [
            { kind: 'text', text: 'Got it. I\u2019ll use the naming convention you selected.' },
            { kind: 'toolCall', toolCall: askUserCompletedTool },
          ],
          toolCalls: [askUserCompletedTool],
        }),
      ],
    }),
  },
];

export const defaultDevFixtureId = 'chat';

export function getDevFixture(id: string | null | undefined): DevFixture {
  return devFixtures.find((fixture) => fixture.id === id) ?? devFixtures.find((fixture) => fixture.id === defaultDevFixtureId)!;
}

export function getDevFixtureIds(): string[] {
  return devFixtures.map((fixture) => fixture.id);
}
