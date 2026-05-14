import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamSmoother, DEFAULT_STREAM_SMOOTHER_CONFIG } from '../src/webview/panel/stream-smoother';
import type { PatchOp } from '../src/shared/protocol';

test('StreamSmoother uses default config when no overrides provided', () => {
  let flushCalls = 0;
  const smoother = new StreamSmoother({}, () => flushCalls++);
  assert.equal(flushCalls, 0);
});

test('StreamSmoother applies non-delta patches immediately', () => {
  let flushedOverlay: ReturnType<typeof smoother.processPatch> | null = null;
  const smoother = new StreamSmoother({}, (o) => { flushedOverlay = o; });

  const toolOp: PatchOp = {
    kind: 'toolCall',
    messageId: 'msg1',
    toolCall: {
      id: 'tool1',
      name: 'test',
      input: {},
      status: 'running',
    },
  };

  const result = smoother.processPatch(toolOp);
  assert.ok(flushedOverlay !== null);
  assert.ok(flushedOverlay!.partsByMessage.has('msg1'));
  assert.equal(result, flushedOverlay);
});

test('StreamSmoother applies small deltas immediately without smoothing', () => {
  let flushedOverlay: ReturnType<typeof smoother.processPatch> | null = null;
  const smoother = new StreamSmoother({}, (o) => { flushedOverlay = o; });

  const smallDelta: PatchOp = {
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'hi',
  };

  const result = smoother.processPatch(smallDelta);
  assert.ok(flushedOverlay !== null);
  assert.equal(result.partsByMessage.get('msg1')?.length, 1);
  assert.equal(result.partsByMessage.get('msg1')?.[0].text, 'hi');
});

test('StreamSmoother applies large deltas immediately without smoothing', () => {
  let flushedOverlay: ReturnType<typeof smoother.processPatch> | null = null;
  const smoother = new StreamSmoother({ maxImmediateChars: 10 }, (o) => { flushedOverlay = o; });

  const largeDelta: PatchOp = {
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'this is a large chunk of text',
  };

  const result = smoother.processPatch(largeDelta);
  assert.ok(flushedOverlay !== null);
  assert.equal(result.partsByMessage.get('msg1')?.[0].text, 'this is a large chunk of text');
});

test('StreamSmoother buffers medium deltas for smoothing', () => {
  const smoother = new StreamSmoother(
    { minCharsForSmoothing: 5, maxImmediateChars: 200 },
    () => {},
  );

  const mediumDelta: PatchOp = {
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'hello world',
  };

  smoother.processPatch(mediumDelta);

  // Delta is buffered, not immediately applied to overlay
  assert.equal(smoother.getPendingCharCount(), 11);
});

test('StreamSmoother flushAll emits all pending deltas', () => {
  const smoother = new StreamSmoother(
    { minCharsForSmoothing: 5, maxImmediateChars: 200 },
    () => {},
  );

  smoother.processPatch({
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'buffered text',
  });

  assert.equal(smoother.getPendingCharCount(), 13);

  const result = smoother.flushAll();

  assert.ok(result.partsByMessage.get('msg1'));
  assert.equal(result.partsByMessage.get('msg1')?.[0].text, 'buffered text');
  assert.equal(smoother.getPendingCharCount(), 0);
});

test('StreamSmoother reset clears pending deltas', () => {
  const smoother = new StreamSmoother(
    { minCharsForSmoothing: 5, maxImmediateChars: 200 },
    () => {},
  );

  smoother.processPatch({
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'some text',
  });

  assert.equal(smoother.getPendingCharCount(), 9);

  smoother.reset();

  assert.equal(smoother.getPendingCharCount(), 0);
});

test('StreamSmoother getPendingCharCount returns sum of pending delta lengths', () => {
  const smoother = new StreamSmoother(
    { minCharsForSmoothing: 3, maxImmediateChars: 200 },
    () => {},
  );

  assert.equal(smoother.getPendingCharCount(), 0);

  smoother.processPatch({
    kind: 'messageDelta',
    messageId: 'msg1',
    delta: 'hello',
  });

  assert.equal(smoother.getPendingCharCount(), 5);

  smoother.processPatch({
    kind: 'messageDelta',
    messageId: 'msg2',
    delta: 'world',
  });

  assert.equal(smoother.getPendingCharCount(), 10);
});

test('StreamSmoother default config has sensible values', () => {
  assert.equal(DEFAULT_STREAM_SMOOTHER_CONFIG.charsPerSecond, 30);
  assert.equal(DEFAULT_STREAM_SMOOTHER_CONFIG.minCharsForSmoothing, 5);
  assert.equal(DEFAULT_STREAM_SMOOTHER_CONFIG.maxSmoothBatch, 50);
  assert.equal(DEFAULT_STREAM_SMOOTHER_CONFIG.maxImmediateChars, 200);
  assert.equal(DEFAULT_STREAM_SMOOTHER_CONFIG.minEmitIntervalMs, 16);
});