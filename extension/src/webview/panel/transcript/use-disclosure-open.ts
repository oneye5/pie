import { useEffect, useMemo, useState } from 'preact/hooks';

import { syncDisclosureOpenState } from '../disclosure-state';

const disclosureOpenByKey = new Map<string, boolean>();
const disclosureDefaultByKey = new Map<string, boolean>();

export function useDisclosureOpen(storageKey: string, defaultOpen: boolean) {
  const resolvedStorageKey = useMemo(() => storageKey || '__anonymous__', [storageKey]);
  const [open, setOpen] = useState<boolean>(() => {
    if (disclosureOpenByKey.has(resolvedStorageKey)) {
      return disclosureOpenByKey.get(resolvedStorageKey)!;
    }
    disclosureDefaultByKey.set(resolvedStorageKey, defaultOpen);
    return defaultOpen;
  });

  useEffect(() => {
    const previousDefaultOpen = disclosureDefaultByKey.get(resolvedStorageKey) ?? defaultOpen;
    const currentOpen = disclosureOpenByKey.get(resolvedStorageKey) ?? open;
    const nextOpen = syncDisclosureOpenState(currentOpen, previousDefaultOpen, defaultOpen);
    disclosureDefaultByKey.set(resolvedStorageKey, defaultOpen);
    disclosureOpenByKey.set(resolvedStorageKey, nextOpen);
    setOpen(nextOpen);
  }, [resolvedStorageKey, defaultOpen]);

  useEffect(() => {
    disclosureOpenByKey.set(resolvedStorageKey, open);
  }, [resolvedStorageKey, open]);

  return [open, setOpen] as const;
}
