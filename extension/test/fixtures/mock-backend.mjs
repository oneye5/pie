#!/usr/bin/env node
/**
 * Mock PI backend.
 *
 * Simulates the minimal subset of the PI backend protocol used in integration
 * tests:
 *   - Emits `backend.ready` on startup.
 *   - Responds to `app.ping`, `session.list`, `session.open`, and `message.send`.
 *   - After `message.send`, emits a minimal streaming sequence:
 *       message.started → message.delta × 2 → tool.started → tool.finished → message.finished
 *   - Emits `busy.changed` around the streaming sequence.
 *   - Exits cleanly after receiving `test.shutdown` or after 5 seconds of inactivity.
 */

import * as readline from 'node:readline';

const SESSION_PATH = '/mock/sessions/test-session.jsonl';
const SESSION_NAME = 'Test Session';
const CWD = '/mock';

let seq = 0;

function emit(event, payload) {
  process.stdout.write(JSON.stringify({ event, payload }) + '\n');
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ id, ok: false, error: { code, message } }) + '\n');
}

// Emit backend.ready immediately.
emit('backend.ready', {
  sdkPath: '/mock/sdk',
  agentDir: '/mock/agent',
  sdkVersion: '0.0.0-mock',
  protocolVersion: 1,
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const inactivityTimer = setTimeout(() => process.exit(0), 5000);

rl.on('line', (line) => {
  clearTimeout(inactivityTimer);
  // Reset inactivity timer on each line
  inactivityTimer.refresh();

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'app.ping':
      respond(id, { pong: true });
      break;

    case 'session.list':
      respond(id, {
        sessions: [{
          path: SESSION_PATH,
          name: SESSION_NAME,
          cwd: CWD,
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
          isPlaceholder: false,
        }],
      });
      break;

    case 'session.open': {
      const sessionPath = params?.path ?? SESSION_PATH;
      respond(id, { ok: true });
      emit('session.opened', {
        session: {
          path: sessionPath,
          name: SESSION_NAME,
          cwd: CWD,
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
          isPlaceholder: false,
        },
        transcript: [],
        busy: false,
        systemPrompt: 'You are a helpful assistant.',
        modelSettings: { defaultModel: 'claude-mock', defaultThinkingLevel: 'medium' },
        availableModels: [{ id: 'claude-mock', name: 'Claude Mock', provider: 'mock', reasoning: false }],
      });
      break;
    }

    case 'message.send': {
      const requestId = params?.requestId ?? 'rq-mock-1';
      const messageId = 'msg-mock-1';
      const toolCallId = 'tc-mock-1';
      const sessionPath = params?.sessionPath ?? SESSION_PATH;

      respond(id, { requestId });

      // Busy on
      seq += 1;
      emit('busy.changed', { sessionPath, busy: true, seq });

      // Stream sequence (async to give test time to read)
      setTimeout(() => {
        emit('message.started', { requestId, messageId, sessionPath });

        setTimeout(() => {
          emit('message.delta', { requestId, messageId, sessionPath, delta: 'Hello' });

          setTimeout(() => {
            emit('message.delta', { requestId, messageId, sessionPath, delta: ', world!' });

            setTimeout(() => {
              emit('tool.started', { requestId, messageId, toolCallId, sessionPath, name: 'read_file', input: { path: '/mock/file.ts' } });

              setTimeout(() => {
                emit('tool.finished', { requestId, messageId, toolCallId, sessionPath, result: 'const x = 1;' });

                setTimeout(() => {
                  emit('message.finished', {
                    requestId,
                    sessionPath,
                    message: {
                      id: messageId,
                      role: 'assistant',
                      createdAt: new Date().toISOString(),
                      markdown: 'Hello, world!',
                      status: 'completed',
                      toolCalls: [{
                        id: toolCallId,
                        name: 'read_file',
                        input: { path: '/mock/file.ts' },
                        result: 'const x = 1;',
                        status: 'completed',
                      }],
                    },
                  });

                  // Busy off
                  seq += 1;
                  emit('busy.changed', { sessionPath, busy: false, seq });
                }, 10);
              }, 10);
            }, 10);
          }, 10);
        }, 10);
      }, 10);
      break;
    }

    case 'message.interrupt':
      respond(id, { ok: true });
      seq += 1;
      emit('busy.changed', { sessionPath: params?.sessionPath ?? SESSION_PATH, busy: false, seq });
      break;

    case 'test.shutdown':
      respond(id, { ok: true });
      setTimeout(() => process.exit(0), 50);
      break;

    default:
      respondError(id, 'METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
