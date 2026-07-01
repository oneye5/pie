import { useCallback } from 'preact/hooks';

export function useJumpToLatest(
  scrollRef: { current: HTMLDivElement | null },
  setAutoFollow: (v: boolean) => void,
  hasNewer: boolean,
  onJumpToLatest: () => void,
  scrollToBottom: () => void,
  pendingJumpToLatestSnapRef: { current: boolean },
) {
  return useCallback(() => {
    setAutoFollow(true);
    if (hasNewer) {
      pendingJumpToLatestSnapRef.current = true;
      onJumpToLatest();
      return;
    }
    scrollToBottom();
  }, [hasNewer, onJumpToLatest, scrollToBottom, setAutoFollow]);
}
