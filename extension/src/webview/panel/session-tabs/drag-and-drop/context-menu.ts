import { useState, useCallback, useEffect } from 'preact/hooks';
import type { SessionTabRunAction } from '../run-state';
import type { SessionTabContextAction } from '../types';

export function useTabContextMenu({
  onDuplicate,
  onClose,
  onTogglePin,
  onRunAction,
}: {
  onDuplicate: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onTogglePin: (tabPath: string) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
}) {
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabPath: string } | null>(null);

  const onContextMenu = useCallback((event: MouseEvent, tabPath: string) => {
    event.preventDefault();
    setTabContextMenu({ x: event.clientX, y: event.clientY, tabPath });
  }, []);

  const onContextAction = useCallback((action: SessionTabContextAction, tabPath: string) => {
    setTabContextMenu(null);
    if (action === 'duplicate') {
      onDuplicate(tabPath);
    } else if (action === 'close') {
      onClose(tabPath);
    } else if (action === 'pin' || action === 'unpin') {
      onTogglePin(tabPath);
    } else {
      onRunAction(action, tabPath);
    }
  }, [onDuplicate, onClose, onTogglePin, onRunAction]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onDown = (e: MouseEvent) => {
      const menuEl = document.querySelector('.session-tab-context-menu');
      if (menuEl && menuEl.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [tabContextMenu]);

  return {
    tabContextMenu,
    setTabContextMenu,
    onContextMenu,
    onContextAction,
  };
}
