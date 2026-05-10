/**
 * Mock PI backend integration tests.
 *
 * Spawns the mock-backend.mjs fixture directly and exercises the JSONL protocol
 * layer without needing vscode or a real PI SDK install. Tests:
 *
 *   1. Protocol bootstrap — mock emits backend.ready with expected fields.
 *   2. Request/response round-trip — app.ping returns a response envelope.
 *   3. session.list response shape.
 *   4. session.open triggers session.opened event.
 *   5. message.send triggers the full streaming event sequence.
 *   6. Event envelopes satisfy isEventEnvelope from shared protocol.
 *   7. Response envelopes satisfy isResponseEnvelope from shared protocol.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as path from 'node:path';

import {
  isEventEnvelope,
  isResponseEnvelope,
  PROTOCOL_VERSION,
} from '../src/shared/protocol';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;
const MOCK_BACKEND_PATH = path.join(__dirname, 'fixtures', 'mock-backend.mjs');

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Line {
  raw: string;
  parsed: unknown;
}

/**
 * Spawns the mock backend and returns utilities for sending requests and
 * collecting output lines with a per-line timeout.
 */
function spawnMockBackend() {
  const proc = cp.spawn(process.execPath, [MOCK_BACKEND_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const lines: Line[] = [];
  const waiters: Array<(line: Line) => void> = [];
  let buffer = '';
  let closed = false;

  const pushLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return; }
    const line: Line = { raw: trimmed, parsed };
    const waiter = waiters.shift();
    if (waiter) {
      // Deliver directly to the waiting consumer — do NOT push to lines.
      waiter(line);
    } else {
      lines.push(line);
    }
  };

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) pushLine(part);
  });
  proc.stdout!.on('end', () => {
    if (buffer.trim()) pushLine(buffer);
    closed = true;
    for (const w of waiters) w({ raw: '', parsed: null });
  });

  proc.stderr!.setEncoding('utf8');

  /** Read the next JSONL line from stdout, rejecting after `timeoutMs`. */
  function nextLine(timeoutMs = 2000): Promise<Line> {
    if (lines.length > 0) return Promise.resolve(lines.shift()!);
    if (closed) return Promise.resolve({ raw: '', parsed: null });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for next line after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  /** Send a JSONL request to the backend. */
  function send(method: string, params?: unknown): string {
    const id = `test-${method}-${Date.now()}`;
    proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    return id;
  }

  /** Shut down the mock backend gracefully. */
  function shutdown(): Promise<void> {
    send('test.shutdown');
    return new Promise((resolve) => proc.on('exit', () => resolve()));
  }

  return { proc, nextLine, send, shutdown };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('mock backend emits backend.ready on startup', async () => {
  const { nextLine, shutdown } = spawnMockBackend();
  try {
    const line = await nextLine();

    assert.ok(isEventEnvelope(line.parsed), 'First line should be an EventEnvelope');
    const env = line.parsed as { event: string; payload: Record<string, unknown> };
    assert.equal(env.event, 'backend.ready');
    assert.equal(env.payload.protocolVersion, PROTOCOL_VERSION, 'Protocol version must match');
    assert.equal(typeof env.payload.sdkVersion, 'string');
    assert.equal(typeof env.payload.sdkPath, 'string');
    assert.equal(typeof env.payload.agentDir, 'string');
  } finally {
    await shutdown();
  }
});

test('app.ping returns a valid ResponseEnvelope', async () => {
  const { nextLine, send, shutdown } = spawnMockBackend();
  try {
    await nextLine(); // skip backend.ready

    const id = send('app.ping');
    const line = await nextLine();

    assert.ok(isResponseEnvelope(line.parsed), 'app.ping reply should be a ResponseEnvelope');
    const env = line.parsed as { id: string; ok: boolean };
    assert.equal(env.id, id);
    assert.equal(env.ok, true);
  } finally {
    await shutdown();
  }
});

test('session.list returns sessions array', async () => {
  const { nextLine, send, shutdown } = spawnMockBackend();
  try {
    await nextLine(); // skip backend.ready

    const id = send('session.list');
    const line = await nextLine();

    assert.ok(isResponseEnvelope(line.parsed));
    const env = line.parsed as { id: string; ok: true; result: { sessions: unknown[] } };
    assert.equal(env.id, id);
    assert.equal(env.ok, true);
    assert.ok(Array.isArray(env.result.sessions), 'result.sessions should be an array');
    assert.ok(env.result.sessions.length > 0, 'At least one session should be returned');

    const session = env.result.sessions[0] as Record<string, unknown>;
    assert.equal(typeof session.path, 'string');
    assert.equal(typeof session.name, 'string');
  } finally {
    await shutdown();
  }
});

test('session.open triggers session.opened EventEnvelope', async () => {
  const { nextLine, send, shutdown } = spawnMockBackend();
  try {
    await nextLine(); // skip backend.ready

    const id = send('session.open', { path: '/mock/sessions/test-session.jsonl' });

    // Response
    const responseLine = await nextLine();
    assert.ok(isResponseEnvelope(responseLine.parsed));
    const resp = responseLine.parsed as { id: string; ok: boolean };
    assert.equal(resp.id, id);
    assert.equal(resp.ok, true);

    // Event
    const eventLine = await nextLine();
    assert.ok(isEventEnvelope(eventLine.parsed), 'session.open should emit an event');
    const env = eventLine.parsed as { event: string; payload: Record<string, unknown> };
    assert.equal(env.event, 'session.opened');
    assert.ok(env.payload.session, 'payload should include session');
    assert.ok(Array.isArray(env.payload.transcript), 'payload should include transcript');
    assert.deepEqual(env.payload.contextUsage, {
      tokens: 64000,
      contextWindow: 200000,
      percent: 32,
    });
    assert.deepEqual(env.payload.availableModels, [{
      id: 'claude-mock',
      name: 'Claude Mock',
      provider: 'mock',
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 8192,
    }]);
  } finally {
    await shutdown();
  }
});

test('message.send triggers full streaming sequence', async () => {
  const { nextLine, send, shutdown } = spawnMockBackend();
  try {
    await nextLine(); // skip backend.ready

    const id = send('message.send', {
    requestId: 'rq-test-1',
    sessionPath: '/mock/sessions/test-session.jsonl',
    text: 'Hello',
  });

  // Collect lines until we see busy.changed with busy=false (end of streaming sequence),
  // or until we reach a reasonable maximum.
  const collected: string[] = [];
  let done = false;
  while (!done && collected.length < 20) {
    const line = await nextLine(3000);
    if (!line.raw) break;
    collected.push(line.raw);
    // The mock ends streaming with busy.changed { busy: false }
    try {
      const p = JSON.parse(line.raw) as { event?: string; payload?: { busy?: boolean } };
      if (p.event === 'busy.changed' && p.payload?.busy === false) done = true;
    } catch { /* not JSON, skip */ }
  }

  const parsed = collected.map((l) => JSON.parse(l));
  const events = parsed.filter(isEventEnvelope) as { event: string }[];
  const responses = parsed.filter(isResponseEnvelope);

  // Should have a response to the send
  assert.ok(responses.some((r: { id: string }) => r.id === id), 'message.send should have a response');

  // Should have the streaming event types
  const eventNames = events.map((e) => e.event);
  assert.ok(eventNames.includes('busy.changed'), 'busy.changed should be emitted');
  assert.ok(eventNames.includes('message.started'), 'message.started should be emitted');
  assert.ok(eventNames.includes('message.delta'), 'message.delta should be emitted');
  assert.ok(eventNames.includes('message.finished'), 'message.finished should be emitted');
  assert.ok(eventNames.includes('tool.started'), 'tool.started should be emitted');
  assert.ok(eventNames.includes('tool.finished'), 'tool.finished should be emitted');

  // busy.changed: first should be busy=true, last should be busy=false
  const busyEvents = events
    .filter((e) => e.event === 'busy.changed') as { event: string; payload: { busy: boolean; seq: number } }[];
  assert.ok(busyEvents.length >= 2, 'Should have at least 2 busy.changed events');
  assert.equal(busyEvents[0].payload.busy, true, 'First busy event should be busy=true');
  assert.equal(busyEvents[busyEvents.length - 1].payload.busy, false, 'Last busy event should be busy=false');

  // Verify seq is monotonically increasing
  const seqs = busyEvents.map((e) => e.payload.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `Busy seq should be monotonically increasing (${seqs[i - 1]} → ${seqs[i]})`);
  }

  // message.finished payload should have a completed message
  const finishedEvent = events.find((e) => e.event === 'message.finished') as
    | { event: string; payload: { message: { status: string; markdown: string } } }
    | undefined;
  assert.ok(finishedEvent, 'message.finished event should exist');
  assert.equal(finishedEvent?.payload.message.status, 'completed');
  assert.equal(typeof finishedEvent?.payload.message.markdown, 'string');
  } finally {
    await shutdown();
  }
});

test('unknown method returns error ResponseEnvelope', async () => {
  const { nextLine, send, shutdown } = spawnMockBackend();
  try {
    await nextLine(); // skip backend.ready

    const id = send('does.not.exist');
    const line = await nextLine();

    assert.ok(isResponseEnvelope(line.parsed));
    const env = line.parsed as { id: string; ok: false; error: { code: string; message: string } };
    assert.equal(env.id, id);
    assert.equal(env.ok, false);
    assert.equal(typeof env.error.code, 'string');
    assert.equal(typeof env.error.message, 'string');
  } finally {
    await shutdown();
  }
});
