/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ViewState, WebviewToHostMessage } from '../../shared/protocol';
import { EMPTY_VIEW_STATE } from './hooks/use-host-sync';
import { AppBody } from './app-body';

export { EMPTY_VIEW_STATE };

export interface AppAdapter {
  postMessage: (msg: WebviewToHostMessage) => void;
  initialState?: ViewState;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  return <AppBody adapter={adapter} />;
}
