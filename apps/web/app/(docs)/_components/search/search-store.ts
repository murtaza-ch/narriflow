import { useEffect, useSyncExternalStore } from "react";

/**
 * Shared state of the search dialog. Triggers are mounted in several places
 * (the sidebar, the mobile menu, the 404 page) and any of them may come and
 * go, so each registers itself and the first one hosts the single dialog.
 */
let open = false;
let triggers: string[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSearchOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  emit();
}

/** Registers a mounted trigger; `host` is true for the one that renders the dialog. */
export function useSearchTrigger(id: string): { host: boolean; open: boolean } {
  useEffect(() => {
    triggers = [...triggers, id];
    emit();
    return () => {
      triggers = triggers.filter((trigger) => trigger !== id);
      emit();
    };
  }, [id]);

  const host = useSyncExternalStore(
    subscribe,
    () => triggers[0] === id,
    () => false,
  );
  const isOpen = useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
  return { host, open: isOpen };
}
