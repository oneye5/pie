import * as cp from 'node:child_process';
import * as vscode from 'vscode';

import { attachJsonlLineReader, serializeJsonLine } from '../../shared/jsonl';
import { RequestTracker } from '../../shared/request-tracker';
import { bootTraceSync } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import {
  assertProtocolVersion,
  type BackendReadyPayload,
  type EventEnvelope,
  isEventEnvelope,
  isResponseEnvelope,
  type ResponseEnvelope,
} from '../../shared/protocol';

export interface BackendStartOptions {
  nodePath: string;
  backendPath: string;
  sdkPath: string;
  cwd: string;
}

/** Maximum number of bytes of stderr we keep in memory (ring buffer). */
const STDERR_BUFFER_LIMIT = 64 * 1024;

/** Default timeout for backend RPC calls if no per-method override is set. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Per-method timeouts. Methods doing disk I/O or batch work get a longer
 * budget; very fast in-memory queries can use the default.
 */
const RPC_TIMEOUTS_MS: Record<string, number> = {
  'runtimePrefs.set': 5_000,
  'session.list': 60_000,
  'session.create': 60_000,
  'session.open': 60_000,
  'session.preload': 60_000,
  'session.loadTranscriptPage': 30_000,
  'settings.set': 60_000,
  'settings.get': 15_000,
  'models.list': 15_000,
  'app.ping': 10_000,
  'message.interrupt': 15_000,
  'extension_ui.response': 10_000,
};

const READY_TIMEOUT_MS = 30_000;

export class BackendClient implements vscode.Disposable {
  private readonly events = new vscode.EventEmitter<EventEnvelope>();
  private readonly exits = new vscode.EventEmitter<{ code: number | null; stderr: string }>();
  private readonly requests = new RequestTracker<ResponseEnvelope>();

  private proc?: cp.ChildProcess;
  private requestCounter = 0;
  private stderrBuffer = '';
  private detachReader?: () => void;

  readonly onEvent = this.events.event;
  readonly onExit = this.exits.event;

  /**
   * Start the backend. Safe to call again after a previous backend exited
   * (we no longer hard-reject when `proc` is set — it's been cleared on exit).
   */
  async start(options: BackendStartOptions): Promise<BackendReadyPayload> {
    if (this.proc) {
      throw new Error('Backend is already running');
    }

    this.stderrBuffer = '';
    const proc = cp.spawn(
      options.nodePath,
      [options.backendPath, '--sdkPath', options.sdkPath, '--cwd', options.cwd],
      {
        cwd: options.cwd,
        env: { ...process.env, PIE_EDITOR_VERSION: vscode.version },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    );

    this.proc = proc;

    if (!proc.stdout || !proc.stderr || !proc.stdin) {
      this.proc = undefined;
      throw new Error('Backend process did not expose stdio pipes as expected.');
    }

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.appendStderr(chunk);
    });

    proc.on('exit', (code) => {
      this.detachReader?.();
      this.detachReader = undefined;
      this.proc = undefined;
      this.requests.rejectAll(
        new Error(`Backend exited unexpectedly${code === null ? '' : ` with code ${code}`}.`),
      );
      this.exits.fire({ code, stderr: this.stderrBuffer.trim() });
    });

    proc.on('error', (error) => {
      this.requests.rejectAll(error);
    });

    return new Promise<BackendReadyPayload>((resolve, reject) => {
      let settled = false;

      const finishReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        readyDisposable.dispose();
        exitDisposable.dispose();
        errorDisposable.dispose();
        clearTimeout(timeout);
        reject(error);
      };

      const finishResolve = (payload: BackendReadyPayload) => {
        if (settled) {
          return;
        }
        settled = true;
        readyDisposable.dispose();
        exitDisposable.dispose();
        errorDisposable.dispose();
        clearTimeout(timeout);
        resolve(payload);
      };

      const readyDisposable = this.onEvent((event) => {
        if (event.event !== 'backend.ready') {
          return;
        }

        try {
          const payload = event.payload as BackendReadyPayload;
          assertProtocolVersion('backend.ready', payload.protocolVersion);
          finishResolve(payload);
        } catch (error) {
          finishReject(error instanceof Error ? error : new Error(String(error)));
          void this.stop().catch(() => undefined);
        }
      });

      const exitDisposable = this.onExit(({ code, stderr }) => {
        finishReject(
          new Error(
            `Backend failed to start${code === null ? '' : ` (code ${code})`}${
              stderr ? `: ${stderr}` : ''
            }`,
          ),
        );
      });

      const errorListener = (error: Error) => {
        this.proc = undefined;
        finishReject(
          new Error(
            `Failed to spawn pie backend with node=${options.nodePath}, backend=${options.backendPath}, cwd=${options.cwd}: ${error.message}`,
          ),
        );
      };
      proc.once('error', errorListener);
      const errorDisposable = { dispose: () => proc.off('error', errorListener) };

      const timeout = setTimeout(() => {
        finishReject(new Error('Timed out waiting for the pie backend to become ready.'));
      }, READY_TIMEOUT_MS);

      // Attach stdout after the ready/exit/error listeners are armed. A fast
      // backend can emit `backend.ready` immediately on startup; attaching the
      // line reader earlier can drop that event before `start()` subscribes.
      this.detachReader = attachJsonlLineReader(proc.stdout, (line) => {
        this.handleLine(line);
      });
    });
  }

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (!this.proc?.stdin) {
      throw new Error('Backend is not running');
    }

    const id = `req-${++this.requestCounter}`;
    const timeoutMs = RPC_TIMEOUTS_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
    const responsePromise = this.requests.create(id, timeoutMs);

    bootTraceSync('backend-client', 'request.sent', { id, method, timeoutMs });
    this.proc.stdin.write(serializeJsonLine({ id, method, params }));

    try {
      const response = await responsePromise;
      bootTraceSync('backend-client', 'response.received', { id, method });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.result as TResult;
    } catch (error) {
      bootTraceSync('backend-client', 'request.failed', { id, method, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Stop the running backend. Safe to call when no backend is running. Use
   * `start()` again afterwards to bring up a fresh process.
   */
  async stop(): Promise<void> {
    this.detachReader?.();
    this.detachReader = undefined;
    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }
    this.requests.rejectAll(new Error('Backend stopped.'));
  }

  private handleLine(line: string): void {
    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch (error) {
      // The backend should only emit valid JSON-RPC envelopes on stdout. A parse
      // failure here typically means a stray log line or a corrupted stream,
      // and silently dropping it has previously been a source of "random hangs"
      // (an expected event never arrives, the UI stays busy forever, the RPC
      // eventually times out with no clear cause). Surface it loudly so the
      // failure mode is debuggable.
      const preview = line.length > 200 ? `${line.slice(0, 200)}…` : line;
       
      console.warn(`[pie] dropped non-JSON backend line: ${toErrorMessage(error)} :: ${preview}`);
      return;
    }

    if (isResponseEnvelope(value)) {
      this.requests.resolve(value.id, value);
      return;
    }

    if (isEventEnvelope(value)) {
      this.events.fire(value);
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
      // Keep only the trailing window — most diagnostics live near the end.
      this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
    }
  }

  dispose(): void {
    this.detachReader?.();
    this.detachReader = undefined;

    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }

    this.requests.rejectAll(new Error('Backend client disposed.'));
    this.events.dispose();
    this.exits.dispose();
  }
}
