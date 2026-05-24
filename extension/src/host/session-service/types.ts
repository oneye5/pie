import type { SessionCompletionEvent } from '../sidebar/completion-notification';
import type { HostToWebviewMessage } from '../../shared/protocol';
import type { BackendEvent } from '../core/events';

export type ScheduleRender = () => void;
export type PostImperative = (message: HostToWebviewMessage) => void;
export type OnSessionCompleted = (event: SessionCompletionEvent) => void;
export type DispatchArchEvent = (event: BackendEvent) => void;
export type ResolveMessageAlias = (messageId: string) => string;

export type SelectionRequest = {
  token: string;
  requestedPath: string;
  pendingPath?: string;
  insertedPlaceholder: boolean;
  previousActivePath: string | null;
  wasOpenTab: boolean;
  requestEpoch?: number;
};
