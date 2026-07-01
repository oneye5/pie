import { useEffect } from 'preact/hooks';

import { isNearBottom, resolveAutoFollowState } from '../auto-scroll';

export function useScrollEventsEffect(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  setAutoFollow: (v: boolean) => void,
  hasOlder: boolean,
  requestOlderPage: () => void,
  sessionKey: string | null,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const next = el.scrollTop;
      const metrics = { scrollHeight: el.scrollHeight, scrollTop: next, clientHeight: el.clientHeight };
      const follow = resolveAutoFollowState({
        previousAutoFollow: autoFollowRef.current,
        previousScrollTop: lastScrollTopRef.current,
        nextScrollTop: next,
        metrics,
      });
      setAutoFollow(follow);
      lastScrollTopRef.current = next;
      setIsAtBottom(follow || isNearBottom(metrics));
      if (el.scrollTop <= 120 && hasOlder) requestOlderPage();
    };

    el.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, requestOlderPage, sessionKey, hasOlder, autoFollowRef, lastScrollTopRef, setIsAtBottom, setAutoFollow]);
}
