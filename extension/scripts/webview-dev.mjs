import { access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const workspaceRoot = path.dirname(rootDir);
const panelOutDir = path.join(rootDir, 'out', 'webview', 'panel');
const backendPath = path.join(rootDir, 'out', 'backend.js');
const defaultPort = Number.parseInt(process.env.PIE_WEBVIEW_DEV_PORT ?? '8790', 10);
const WEBVIEW_PROTOCOL_VERSION = 1;
const BACKEND_PROTOCOL_VERSION = 10;
const EMPTY_TRANSCRIPT_WINDOW = { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false };
const mimeTypes = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.map', 'application/json; charset=utf-8'], ['.json', 'application/json; charset=utf-8']]);

const initialPrefs = { autoExpandReasoning: false, autoExpandToolCalls: false, autoExpandSubagentCalls: false, suppressCompletionNotifications: false, showPruningMessages: true, completionSoundVolume: 50, extensionToggles: {}, providerToggles: {} };
const initialPruningSettings = { mode: 'auto', skillCeiling: 5, toolCeiling: 5, skillAlwaysKeep: [], toolAlwaysKeep: [], model: 'gpt-5.4-mini', provider: 'github-copilot', thinkingLevel: 'minimal', prepassTimeoutSec: null };
// Parity markers for the service-backed browser dev host contract:
// headlessHostPath HeadlessWebviewDevHost host.handleBackendEvent(event) hostState()
// const PENDING_SESSION_PREFIX = '__pending__:' function createPendingSessionPath() function applyCreatedSessionOpened(payload, selectionToken)
// function cancelPendingCreateForPath(sessionPath) function clearTransientSessionUi() function setSessionRunning(sessionPath, running)
// const pendingInterruptRequests = new Set() function resolveInterruptSessionPath(sessionPath) function drainPendingInterrupt(pendingPath, resolvedPath)
// case 'openFilePicker': case 'openFile': case 'openFileDiff': case 'revertFile': case 'startNewTask': case 'continueTask': case 'stateApplied':
const knownExtensions = [
  { id: 'subagent', label: 'Subagent', description: 'Delegate tasks to specialized sub-agents' },
  { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous shell commands and file writes' },
  { id: 'cwd-skills', label: 'CWD Skills', description: 'Auto-discover skills from the working directory' },
  { id: 'skill-pruner', label: 'Skill Pruner', description: 'Score and prune skill descriptions by relevance' },
];

const hostInstanceId = `webview-dev-${Date.now()}`;
const clients = new Set();
let revision = 0;
let buildProcess;
let backend;
const state = {
  backendReady: false,
  notice: 'Starting PI backend...',
  sessions: [],
  openTabPaths: [],
  runningSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSessionPath: null,
  transcripts: {},
  transcriptWindows: {},
  systemPrompts: {},
  pendingComposerInputs: {},
  runSummariesBySession: {},
  analyticsFactorsBySession: {},
  fileChangesBySession: {},
  availableModelsBySession: {},
  contextUsageBySession: {},
  modelSettings: null,
  prefs: { ...initialPrefs },
  availableExtensions: knownExtensions,
  pruningSettings: { ...initialPruningSettings },
  editingMessageId: null,
  showOutcomeDialog: false,
  pendingExtensionUIRequest: null,
};

function startBuildWatch() {
  const child = spawn(process.execPath, ['./scripts/build.mjs', '--watch', '--skip-typecheck', '--no-sync'], { cwd: rootDir, stdio: 'inherit' });
  child.on('exit', (code, signal) => { if (!signal) console.error(`[webview-dev] build watcher exited with code ${code ?? 'unknown'}`); });
  return child;
}

async function waitForBuiltArtifacts(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await Promise.all([access(path.join(panelOutDir, 'dev.html')), access(path.join(panelOutDir, 'dev.js')), access(path.join(panelOutDir, 'panel.css')), access(backendPath)]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for built artifacts under ${path.join(rootDir, 'out')}`);
}

function staticPathFor(requestUrl = '/') {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const rawPath = url.pathname === '/' ? '/dev.html' : url.pathname;
  const normalized = path.normalize(decodeURIComponent(rawPath)).replace(/^([/\\])+/, '');
  if (normalized.startsWith('..')) return null;
  return path.join(panelOutDir, normalized);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : null); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => key && !key.startsWith('=') && value !== undefined && !String(value).includes('\0')),
  );
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function transcriptWindowFor(transcript) {
  return { ...EMPTY_TRANSCRIPT_WINDOW, totalCount: transcript.length, loadedStart: 0, loadedEnd: transcript.length, hasUserMessages: transcript.some((message) => message.role === 'user') };
}

function normalizeMessage(message) {
  if (message?.role !== 'assistant' || (Array.isArray(message.parts) && message.parts.length > 0)) return message;
  return { ...message, parts: message.markdown ? [{ kind: 'text', text: message.markdown }] : [] };
}

function activeSession() {
  return state.sessions.find((session) => session.path === state.activeSessionPath) ?? null;
}

function derivePruningResult(transcript) {
  if (!state.prefs.showPruningMessages || state.pruningSettings.mode === 'off' || state.prefs.extensionToggles?.['skill-pruner'] === false) return null;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    const details = message.customType === 'pruning-result' ? message.customDetails : null;
    if (!details) continue;
    if (details.prepassError) return { skillsKept: 0, skillsTotal: 0, toolsKept: 0, toolsTotal: 0, tokensSaved: 0, hasSkillPruning: false, hasToolPruning: false, error: details.prepassError, details };
    if (!Array.isArray(details.includedSkills)) continue;
    const includedTools = Array.isArray(details.includedTools) ? details.includedTools : [];
    const excludedSkills = Array.isArray(details.excludedSkills) ? details.excludedSkills : [];
    const excludedTools = Array.isArray(details.excludedTools) ? details.excludedTools : [];
    return { skillsKept: details.includedSkills.length, skillsTotal: details.includedSkills.length + excludedSkills.length, toolsKept: includedTools.length, toolsTotal: includedTools.length + excludedTools.length, tokensSaved: (details.skillTokensSaved ?? 0) + (details.toolTokensSaved ?? 0), hasSkillPruning: excludedSkills.length > 0, hasToolPruning: excludedTools.length > 0, details };
  }
  return null;
}

function pruningCatalogFor(sessionPath) {
  const factors = sessionPath ? state.analyticsFactorsBySession[sessionPath] : null;
  if (!factors) return { skills: [], tools: [] };
  return {
    skills: [...new Set((factors.skills ?? []).filter((skill) => !skill.disableModelInvocation).map((skill) => String(skill.name ?? '').trim()).filter(Boolean))].sort(),
    tools: [...new Set((factors.selectedToolIds ?? []).map((tool) => String(tool).trim()).filter(Boolean))].sort(),
  };
}

function viewState() {
  const session = activeSession();
  const sessionPath = session?.path ?? null;
  const transcript = sessionPath ? (state.transcripts[sessionPath] ?? []) : [];
  return {
    sessions: state.sessions,
    openTabPaths: state.openTabPaths,
    runningSessionPaths: state.runningSessionPaths,
    unreadFinishedSessionPaths: state.unreadFinishedSessionPaths,
    activeSession: session,
    transcript,
    transcriptWindow: sessionPath ? (state.transcriptWindows[sessionPath] ?? transcriptWindowFor(transcript)) : EMPTY_TRANSCRIPT_WINDOW,
    transcriptLoaded: sessionPath ? Object.prototype.hasOwnProperty.call(state.transcriptWindows, sessionPath) : false,
    pendingComposerInputs: sessionPath ? (state.pendingComposerInputs[sessionPath] ?? []) : [],
    activeRunSummary: sessionPath ? (state.runSummariesBySession[sessionPath] ?? null) : null,
    runSummariesBySession: state.runSummariesBySession,
    busy: !!sessionPath && state.runningSessionPaths.includes(sessionPath),
    notice: state.notice,
    backendReady: state.backendReady,
    workspaceCwd: workspaceRoot,
    systemPrompts: sessionPath ? (state.systemPrompts[sessionPath] ?? []) : [],
    modelSettings: state.modelSettings,
    availableModels: sessionPath ? (state.availableModelsBySession[sessionPath] ?? []) : [],
    contextUsage: sessionPath ? (state.contextUsageBySession[sessionPath] ?? null) : null,
    prefs: state.prefs,
    availableExtensions: state.availableExtensions,
    fileChanges: sessionPath ? (state.fileChangesBySession[sessionPath] ?? []) : [],
    pruningResult: derivePruningResult(transcript),
    pruningSettings: state.pruningSettings,
    pruningCatalog: pruningCatalogFor(sessionPath),
    editingMessageId: state.editingMessageId,
    showOutcomeDialog: state.showOutcomeDialog,
    pendingExtensionUIRequest: state.pendingExtensionUIRequest,
  };
}

function publishState() {
  const message = { type: 'state', protocolVersion: WEBVIEW_PROTOCOL_VERSION, hostInstanceId, revision: ++revision, state: viewState() };
  for (const client of clients) client.write(`data: ${JSON.stringify(message)}\n\n`);
}

function upsertSession(session) {
  const index = state.sessions.findIndex((candidate) => candidate.path === session.path);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
  else state.sessions = [session, ...state.sessions];
}

function ensureOpenTab(sessionPath) {
  if (!state.openTabPaths.includes(sessionPath)) state.openTabPaths = [...state.openTabPaths, sessionPath];
}

function applySessionOpened(payload) {
  const sessionPath = payload.session.path;
  const transcript = (payload.transcript ?? []).map(normalizeMessage);
  upsertSession(payload.session);
  ensureOpenTab(sessionPath);
  state.activeSessionPath = sessionPath;
  state.transcripts[sessionPath] = transcript;
  state.transcriptWindows[sessionPath] = payload.transcriptWindow ?? transcriptWindowFor(transcript);
  state.systemPrompts[sessionPath] = payload.systemPrompts ?? [];
  state.analyticsFactorsBySession[sessionPath] = payload.analyticsFactors ?? null;
  state.pendingComposerInputs[sessionPath] ??= [];
  state.contextUsageBySession[sessionPath] = payload.contextUsage ?? null;
  if (payload.modelSettings) state.modelSettings = payload.modelSettings;
  if (payload.availableModels) state.availableModelsBySession[sessionPath] = payload.availableModels;
  publishState();
}

function ensureAssistantMessage(payload) {
  const transcript = state.transcripts[payload.sessionPath] ?? [];
  let message = transcript.find((candidate) => candidate.id === payload.messageId);
  if (!message) {
    message = { id: payload.messageId, role: 'assistant', createdAt: new Date().toISOString(), markdown: '', parts: [], status: 'streaming', toolCalls: [], modelId: payload.modelId, thinkingLevel: payload.thinkingLevel };
    transcript.push(message);
    state.transcripts[payload.sessionPath] = transcript;
  }
  if (payload.modelId) message.modelId = payload.modelId;
  if (payload.thinkingLevel) message.thinkingLevel = payload.thinkingLevel;
  state.transcriptWindows[payload.sessionPath] = transcriptWindowFor(transcript);
  return message;
}

function appendTextPart(message, kind, text) {
  message.markdown = `${message.markdown ?? ''}${text}`;
  message.parts = Array.isArray(message.parts) ? message.parts : [];
  const last = message.parts[message.parts.length - 1];
  if (last?.kind === kind) last.text = `${last.text ?? ''}${text}`;
  else message.parts.push({ kind, text });
}

function upsertToolCall(payload, patch) {
  const message = ensureAssistantMessage(payload);
  message.toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const index = message.toolCalls.findIndex((toolCall) => toolCall.id === payload.toolCallId);
  const toolCall = { ...(index >= 0 ? message.toolCalls[index] : {}), id: payload.toolCallId, ...patch };
  if (index >= 0) message.toolCalls[index] = toolCall;
  else message.toolCalls.push(toolCall);
  message.parts = Array.isArray(message.parts) ? message.parts : [];
  const partIndex = message.parts.findIndex((part) => part.kind === 'toolCall' && part.toolCall?.id === payload.toolCallId);
  if (partIndex >= 0) message.parts[partIndex] = { kind: 'toolCall', toolCall };
  else message.parts.push({ kind: 'toolCall', toolCall });
}

function upsertMessage(sessionPath, message) {
  const transcript = state.transcripts[sessionPath] ?? [];
  const normalized = normalizeMessage(message);
  const index = transcript.findIndex((candidate) => candidate.id === normalized.id);
  if (index >= 0) transcript[index] = normalized;
  else transcript.push(normalized);
  state.transcripts[sessionPath] = transcript;
  state.transcriptWindows[sessionPath] = transcriptWindowFor(transcript);
}

function handleBackendEvent(event) {
  const payload = event.payload ?? {};
  switch (event.event) {
    case 'backend.ready': return;
    case 'session.opened': applySessionOpened(payload); return;
    case 'session.list.changed': state.sessions = payload.sessions ?? state.sessions; break;
    case 'message.started': ensureAssistantMessage(payload); break;
    case 'message.delta': appendTextPart(ensureAssistantMessage(payload), 'text', payload.delta ?? ''); break;
    case 'message.thinking': appendTextPart(ensureAssistantMessage(payload), 'reasoning', payload.thinking ?? ''); break;
    case 'tool.started': upsertToolCall(payload, { name: payload.name, input: payload.input, status: 'running', startedAt: payload.startedAt }); break;
    case 'tool.progress': upsertToolCall(payload, { result: payload.partialResult, status: 'running' }); break;
    case 'tool.finished': upsertToolCall(payload, { result: payload.result, status: payload.status, durationMs: payload.durationMs }); break;
    case 'message.finished':
    case 'message.custom': upsertMessage(payload.sessionPath, payload.message); break;
    case 'message.aborted': {
      const message = (state.transcripts[payload.sessionPath] ?? []).find((candidate) => candidate.id === payload.messageId);
      if (message) message.status = 'interrupted';
      break;
    }
    case 'busy.changed':
      state.runningSessionPaths = payload.busy ? [...new Set([...state.runningSessionPaths, payload.sessionPath])] : state.runningSessionPaths.filter((sessionPath) => sessionPath !== payload.sessionPath);
      if (!payload.busy) state.pendingExtensionUIRequest = null;
      break;
    case 'contextUsage.changed': state.contextUsageBySession[payload.sessionPath] = payload.contextUsage ?? null; break;
    case 'extension_ui.request': state.pendingExtensionUIRequest = payload; break;
    case 'error': state.notice = payload.message ?? 'Backend error'; break;
    default: return;
  }
  publishState();
}

class BackendClient {
  constructor() {
    this.proc = null;
    this.requests = new Map();
    this.counter = 0;
    this.stderr = '';
    this.readyHandler = null;
  }

  start({ nodePath, sdkPath, cwd }) {
    this.proc = spawn(nodePath, [backendPath, '--sdkPath', sdkPath, '--cwd', cwd], { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024); });
    this.proc.stdout.setEncoding('utf8');
    let buffer = '';
    this.proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(line);
      }
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      for (const request of this.requests.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`Backend exited${code === null ? '' : ` with code ${code}`}.`));
      }
      this.requests.clear();
      state.backendReady = false;
      state.runningSessionPaths = [];
      state.notice = `PI backend stopped${code !== null ? ` (code ${code})` : ''}${this.stderr.trim() ? `: ${this.stderr.trim().slice(0, 300)}` : ''}`;
      publishState();
    });
    this.proc.on('error', (error) => {
      state.backendReady = false;
      state.notice = error.message;
      publishState();
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.readyHandler = null; reject(new Error('Timed out waiting for backend.ready')); }, 30000);
      this.readyHandler = (event) => {
        if (event.event !== 'backend.ready') return;
        clearTimeout(timeout);
        this.readyHandler = null;
        const protocolVersion = event.payload?.protocolVersion;
        protocolVersion === BACKEND_PROTOCOL_VERSION ? resolve(event.payload) : reject(new Error(`Backend protocol mismatch: expected ${BACKEND_PROTOCOL_VERSION}, got ${protocolVersion}`));
      };
    });
  }

  handleLine(line) {
    let value;
    try { value = JSON.parse(line); } catch (error) {
      console.warn(`[webview-dev] dropped non-JSON backend line: ${error.message} :: ${line.slice(0, 200)}`);
      return;
    }
    if (value && typeof value === 'object' && 'id' in value && 'ok' in value) {
      const pending = this.requests.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.requests.delete(value.id);
      value.ok ? pending.resolve(value.result) : pending.reject(new Error(value.error?.message ?? 'Backend request failed'));
      return;
    }
    if (value && typeof value === 'object' && 'event' in value) {
      this.readyHandler?.(value);
      handleBackendEvent(value);
    }
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.proc?.stdin) return Promise.reject(new Error('Backend is not running'));
    const id = `dev-${++this.counter}`;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.requests.delete(id); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      this.requests.set(id, { resolve, reject, timeout });
    });
    this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}

async function resolveSdkPath() {
  const candidates = [
    process.env.PI_SDK_PATH?.trim(),
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'node_modules', '@mariozechner', 'pi-coding-agent') : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@mariozechner', 'pi-coding-agent') : undefined,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }

  throw new Error(`Could not find @mariozechner/pi-coding-agent. Set PI_SDK_PATH. Checked: ${candidates.join(', ')}`);
}

async function hydrateModels(sessionPath) {
  if (!backend || !sessionPath || !state.backendReady) return;
  const [models, settings] = await Promise.all([
    backend.request('models.list', { sessionPath }, 15000).catch(() => null),
    backend.request('settings.get', undefined, 15000).catch(() => null),
  ]);
  if (Array.isArray(models)) state.availableModelsBySession[sessionPath] = models;
  if (settings) state.modelSettings = settings;
}

async function openSession(sessionPath) {
  state.activeSessionPath = sessionPath;
  ensureOpenTab(sessionPath);
  publishState();
  applySessionOpened(await backend.request('session.open', { sessionPath, selectionToken: `dev-${Date.now()}` }));
}

async function createSession() {
  applySessionOpened(await backend.request('session.create', { cwd: workspaceRoot, selectionToken: `dev-${Date.now()}` }));
}

async function startBackend() {
  try {
    backend = new BackendClient();
    const sdkPath = await resolveSdkPath();
    await backend.start({ nodePath: process.execPath, sdkPath, cwd: workspaceRoot });
    state.backendReady = true;
    state.notice = null;
    await backend.request('runtimePrefs.set', { providerToggles: state.prefs.providerToggles, extensionToggles: state.prefs.extensionToggles }).catch(() => undefined);
    const settings = await backend.request('settings.get', undefined, 15000).catch(() => null);
    if (settings) state.modelSettings = settings;
    const sessions = await backend.request('session.list');
    state.sessions = Array.isArray(sessions) ? sessions : [];
    publishState();
    if (state.sessions[0]?.path) await openSession(state.sessions[0].path);
    else await createSession();
  } catch (error) {
    state.backendReady = false;
    state.notice = `Failed to start PI backend: ${error.message}`;
    publishState();
  }
}

async function handleWebviewMessage(msg) {
  try {
    switch (msg.type) {
      case 'ready':
      case 'refreshState':
      case 'requestSnapshot': await hydrateModels(state.activeSessionPath); publishState(); return;
      case 'newSession': await createSession(); return;
      case 'openSession': await openSession(msg.sessionPath); return;
      case 'closeSession':
        state.openTabPaths = state.openTabPaths.filter((sessionPath) => sessionPath !== msg.sessionPath);
        if (state.activeSessionPath === msg.sessionPath) state.activeSessionPath = state.openTabPaths[0] ?? null;
        publishState();
        return;
      case 'duplicateSession': applySessionOpened(await backend.request('session.duplicate', { sessionPath: msg.sessionPath, selectionToken: `dev-${Date.now()}` })); return;
      case 'moveSessionTab': {
        const paths = [...state.openTabPaths];
        const [moved] = paths.splice(msg.fromIndex, 1);
        if (moved) paths.splice(msg.toIndex, 0, moved);
        state.openTabPaths = paths;
        publishState();
        return;
      }
      case 'send': {
        const sessionPath = msg.sessionPath;
        const inputs = state.pendingComposerInputs[sessionPath] ?? [];
        if (!sessionPath || (!msg.text?.trim() && inputs.length === 0)) return;
        const transcript = state.transcripts[sessionPath] ?? [];
        transcript.push({ id: msg.localId ?? `local-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), markdown: msg.text ?? '', status: 'completed' });
        state.transcripts[sessionPath] = transcript;
        state.transcriptWindows[sessionPath] = transcriptWindowFor(transcript);
        state.pendingComposerInputs[sessionPath] = [];
        state.runningSessionPaths = [...new Set([...state.runningSessionPaths, sessionPath])];
        publishState();
        await backend.request('message.send', { sessionPath, text: msg.text ?? '', inputs });
        return;
      }
      case 'interrupt': await backend.request('message.interrupt', { sessionPath: msg.sessionPath }); return;
      case 'setModel': {
        const settings = await backend.request('settings.set', { sessionPath: msg.sessionPath, defaultModel: msg.defaultModel, defaultThinkingLevel: msg.defaultThinkingLevel });
        if (settings) state.modelSettings = settings;
        await hydrateModels(msg.sessionPath);
        publishState();
        return;
      }
      case 'addComposerInput': state.pendingComposerInputs[msg.sessionPath] = [...(state.pendingComposerInputs[msg.sessionPath] ?? []), { ...msg.input, id: `input-${Date.now()}-${Math.random().toString(36).slice(2)}` }]; publishState(); return;
      case 'removeComposerInput': state.pendingComposerInputs[msg.sessionPath] = (state.pendingComposerInputs[msg.sessionPath] ?? []).filter((input) => input.id !== msg.inputId); publishState(); return;
      case 'setPrefs':
        state.prefs = { ...state.prefs, ...msg.prefs, extensionToggles: { ...state.prefs.extensionToggles, ...(msg.prefs.extensionToggles ?? {}) }, providerToggles: { ...state.prefs.providerToggles, ...(msg.prefs.providerToggles ?? {}) } };
        await backend?.request('runtimePrefs.set', { providerToggles: state.prefs.providerToggles, extensionToggles: state.prefs.extensionToggles }).catch(() => undefined);
        publishState();
        return;
      case 'setPruningSettings': state.pruningSettings = { ...state.pruningSettings, ...msg.settings }; publishState(); return;
      case 'loadOlderTranscript':
      case 'loadNewerTranscript':
      case 'jumpToLatestTranscript': {
        const sessionPath = msg.sessionPath ?? state.activeSessionPath;
        if (!sessionPath) return;
        const currentWindow = state.transcriptWindows[sessionPath] ?? EMPTY_TRANSCRIPT_WINDOW;
        const direction = msg.type === 'loadOlderTranscript' ? 'older' : msg.type === 'loadNewerTranscript' ? 'newer' : 'latest';
        const payload = await backend.request('session.loadTranscriptPage', { sessionPath, direction, loadedStart: currentWindow.loadedStart, loadedEnd: currentWindow.loadedEnd });
        const transcript = (payload.transcript ?? []).map(normalizeMessage);
        state.transcripts[sessionPath] = transcript;
        state.transcriptWindows[sessionPath] = payload.transcriptWindow ?? transcriptWindowFor(transcript);
        publishState();
        return;
      }
      case 'startEdit': state.editingMessageId = msg.messageId; publishState(); return;
      case 'cancelEdit': state.editingMessageId = null; publishState(); return;
      case 'editMessage': state.editingMessageId = null; state.notice = 'Browser dev live mode does not yet support message editing.'; publishState(); return;
      case 'dismissNotice': state.notice = null; publishState(); return;
      case 'openOutcomeDialog': state.showOutcomeDialog = true; publishState(); return;
      case 'closeOutcomeDialog': state.showOutcomeDialog = false; publishState(); return;
      case 'recordOutcome': state.showOutcomeDialog = false; state.notice = `Recorded outcome: ${msg.outcome.resolution}, satisfaction ${msg.outcome.satisfaction}`; publishState(); return;
      case 'extensionUiResponse': state.pendingExtensionUIRequest = null; publishState(); await backend.request('extension_ui.response', { sessionPath: msg.sessionPath, response: msg.response }); return;
      default: return;
    }
  } catch (error) {
    state.notice = error.message;
    publishState();
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      res.write('\n');
      clients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'state', protocolVersion: WEBVIEW_PROTOCOL_VERSION, hostInstanceId, revision: ++revision, state: viewState() })}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/message') {
      try { await handleWebviewMessage(await readJsonBody(req)); writeJson(res, 200, { ok: true }); }
      catch (error) { writeJson(res, 400, { ok: false, error: error.message }); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return writeJson(res, 200, viewState());

    const filePath = staticPathFor(req.url);
    if (!filePath) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': mimeTypes.get(path.extname(filePath)) ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

async function listenOnAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') void listenOnAvailablePort(port + 1).then(resolve, reject);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

buildProcess = startBuildWatch();
try {
  await waitForBuiltArtifacts();
  const { server, port } = await listenOnAvailablePort(Number.isFinite(defaultPort) ? defaultPort : 8790);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('');
  console.log(`[webview-dev] live: ${baseUrl}/?theme=dark`);
  console.log(`[webview-dev] fixtures: ${baseUrl}/?state=chat | busy | tools | long | attachments | error | files | outcome | extension-ui`);
  console.log(`[webview-dev] themes: add &theme=light or &theme=dark`);
  console.log('');
  void startBackend();
  const shutdown = () => { server.close(); backend?.stop(); buildProcess?.kill('SIGTERM'); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  backend?.stop();
  buildProcess?.kill('SIGTERM');
  console.error('[webview-dev] failed to start:', error);
  process.exitCode = 1;
}