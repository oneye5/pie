import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../src/shared/protocol';

class ImmediateReadyStream extends PassThrough {
  private emitted = false;

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (!this.emitted && eventName === 'data') {
      this.emitted = true;
      listener(Buffer.from(JSON.stringify({
        event: 'backend.ready',
        payload: {
          sdkPath: '/mock/sdk',
          agentDir: '/mock/agent',
          sdkVersion: '0.0.0-test',
          protocolVersion: PROTOCOL_VERSION,
          authPath: '/mock/auth.json',
        },
      }) + '\n'));
    }
    return result;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new ImmediateReadyStream();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

test('BackendClient.start resolves when backend.ready arrives immediately as stdout listener attaches', async () => {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  const fakeProc = new FakeChildProcess() as unknown as cp.ChildProcess;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();

          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };

          fire(value: TValue): void {
            this.emitter.emit('event', value);
          }

          dispose(): void {
            this.emitter.removeAllListeners();
          }
        },
      };
    }

    if (request === 'node:child_process' || request === 'child_process') {
      return {
        ...cp,
        spawn: (() => fakeProc) as typeof cp.spawn,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { BackendClient } = await import('../src/host/backend/client');
  const client = new BackendClient();
  try {
    const payload = await client.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      cwd: '/mock/cwd',
    });

    assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
    assert.equal(payload.sdkPath, '/mock/sdk');
  } finally {
    client.dispose();
    moduleWithLoad._load = originalLoad;
  }
});