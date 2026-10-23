/**
 * A string kept in browser storage and mirrored in memory, so typing still
 * works when storage throws (blocked cookies, private modes).
 */
export function persistedString(storage: "local" | "session", key: string, fallback: string) {
  let memory: string | undefined;
  const listeners = new Set<() => void>();
  const area = () => (storage === "local" ? localStorage : sessionStorage);

  return {
    fallback,
    get(): string {
      if (memory === undefined) {
        try {
          memory = area().getItem(key) ?? fallback;
        } catch {
          memory = fallback;
        }
      }
      return memory;
    },
    set(value: string) {
      memory = value;
      try {
        area().setItem(key, value);
      } catch {
        // The in-memory copy keeps the value for this page view.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
