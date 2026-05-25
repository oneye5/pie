/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/** Context providing the current global notice string (error text) to deeply nested components. */
export const NoticeContext = createContext<string | null>(null);

export function useNotice(): string | null {
  return useContext(NoticeContext);
}
