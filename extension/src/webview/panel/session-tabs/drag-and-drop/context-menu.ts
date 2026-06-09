import { useState, useCallback, useEffect } from 'preact/hooks';

export function useTabContextMenu({
  onDuplicate,
  onClose,
}: {
  onDuplicate: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
}) {
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabPath: string } | null>(null);

  const onContextMenu = useCallback((event: MouseEvent, tabPath: string) => {
    event.preventDefault();
    setTabContextMenu({ x: event.clientX, y: event.clientY, tabPath });
  }, []);

  const onContextAction = useCallback((action: 'duplicate' | 'close', tabPath: string) => {
    setTabContextMenu(null);
    if (action === 'duplicate') {
      onDuplicate(tabPath);
    } else if (action === 'close') {
      onClose(tabPath);
    }
  }, [onDuplicate, onClose]);

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
