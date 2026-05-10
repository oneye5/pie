import type { PatchOp } from '../../shared/protocol';

export interface Overlay {
  deltaByMessage: Map<string, string>;
  thinkingByMessage: Map<string, string>;
}

export function emptyOverlay(): Overlay {
  return { deltaByMessage: new Map(), thinkingByMessage: new Map() };
}

export function applyPatch(overlay: Overlay, op: PatchOp): Overlay {
  const next: Overlay = {
    deltaByMessage: new Map(overlay.deltaByMessage),
    thinkingByMessage: new Map(overlay.thinkingByMessage),
  };

  switch (op.kind) {
    case 'messageDelta': {
      const prev = next.deltaByMessage.get(op.messageId) ?? '';
      next.deltaByMessage.set(op.messageId, prev + op.delta);
      break;
    }
    case 'messageThinking': {
      const prev = next.thinkingByMessage.get(op.messageId) ?? '';
      next.thinkingByMessage.set(op.messageId, prev + op.thinking);
      break;
    }
    case 'toolCall': {
      // Tool call updates arrive via store snapshot; overlay doesn't track them.
      break;
    }
    case 'clearOverlay': {
      if (op.messageIds) {
        for (const id of op.messageIds) {
          next.deltaByMessage.delete(id);
          next.thinkingByMessage.delete(id);
        }
      } else {
        next.deltaByMessage.clear();
        next.thinkingByMessage.clear();
      }
      break;
    }
  }

  return next;
}
