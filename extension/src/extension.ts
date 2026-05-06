import * as cp from 'child_process';
import * as http from 'http';
import * as vscode from 'vscode';

const WEBUI_URL = 'http://127.0.0.1:8787';
const VIEW_TYPE = 'pi-assistant.chatView';

type WebuiState = 'stopped' | 'starting' | 'running';

// ---------------------------------------------------------------------------
// Process manager
// ---------------------------------------------------------------------------
class PiAssistant implements vscode.Disposable {
  private proc: cp.ChildProcess | undefined;
  private _state: WebuiState = 'stopped';

  private readonly _onStateChange = new vscode.EventEmitter<WebuiState>();
  readonly onStateChange = this._onStateChange.event;

  getState(): WebuiState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._state !== 'stopped') return;

    // If already running externally, adopt it
    if (await this.probe()) {
      this.setState('running');
      return;
    }

    this.setState('starting');

    this.proc = cp.spawn('pi-webui', [], {
      stdio: 'pipe',
      env: { ...process.env },
      shell: true,
    });

    this.proc.on('error', (err) => {
      vscode.window.showErrorMessage(`PI Assistant: failed to start pi-webui — ${err.message}`);
      this.proc = undefined;
      this.setState('stopped');
    });

    this.proc.on('exit', () => {
      this.proc = undefined;
      this.setState('stopped');
    });

    // Poll until the server responds
    const ready = await this.waitReady();
    if (ready) {
      this.setState('running');
    } else {
      vscode.window.showWarningMessage('PI Assistant: pi-webui did not become ready — is it installed?');
      this.setState('stopped');
    }
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
    this.setState('stopped');
  }

  dispose(): void {
    this.stop();
    this._onStateChange.dispose();
  }

  private setState(s: WebuiState): void {
    this._state = s;
    this._onStateChange.fire(s);
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(WEBUI_URL, (res) => {
        res.destroy();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async waitReady(attempts = 30, delayMs = 300): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await this.probe()) return true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sidebar status panel
// ---------------------------------------------------------------------------
class PiWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private autoOpened = false;

  constructor(private readonly assistant: PiAssistant) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.refresh(this.assistant.getState());

    this.assistant.onStateChange((state) => {
      this.refresh(state);
      // Auto-open chat the first time pi-webui becomes ready
      if (state === 'running' && !this.autoOpened) {
        this.autoOpened = true;
        openChat();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      switch (msg.command) {
        case 'openChat':
          openChat();
          break;
        case 'start':
          this.assistant.start().catch((err: Error) =>
            vscode.window.showErrorMessage(`PI Assistant: ${err.message}`),
          );
          break;
        case 'stop':
          this.assistant.stop();
          break;
      }
    });
  }

  private refresh(state: WebuiState): void {
    if (this.view) {
      this.view.webview.html = buildHtml(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Open pi-webui in Simple Browser (built-in VSCode extension)
// ---------------------------------------------------------------------------
function openChat(): void {
  vscode.commands.executeCommand('simpleBrowser.show', WEBUI_URL);
}

// ---------------------------------------------------------------------------
// Sidebar HTML — status card with VSCode theme variables
// ---------------------------------------------------------------------------
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function buildHtml(state: WebuiState): string {
  const nonce = getNonce();
  const dotColor =
    state === 'running' ? '#73c991' : state === 'starting' ? '#e9c46a' : '#f48771';
  const label =
    state === 'running' ? 'Running' : state === 'starting' ? 'Starting\u2026' : 'Stopped';

  const buttons =
    state === 'running'
      ? `<button class="btn primary" onclick="send('openChat')">Open Chat</button>
         <button class="btn secondary" onclick="send('stop')">Stop Server</button>`
      : state === 'starting'
        ? `<button class="btn primary" disabled>Starting\u2026</button>`
        : `<button class="btn primary" onclick="send('start')">Start pi\u2011webui</button>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: 12px 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: ${dotColor};
      flex-shrink: 0;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 5px 10px;
      margin-bottom: 6px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .primary:disabled { opacity: 0.5; cursor: default; }
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <div class="status"><div class="dot"></div><span>pi-webui: ${label}</span></div>
  ${buttons}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  const assistant = new PiAssistant();
  context.subscriptions.push(assistant);

  const provider = new PiWebviewProvider(assistant);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Start pi-webui silently in the background on workspace open
  assistant.start().catch(() => {
    /* surfaced via showErrorMessage inside start() */
  });
}

export function deactivate(): void {}
