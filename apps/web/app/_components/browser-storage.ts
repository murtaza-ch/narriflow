/**
 * `window.localStorage` itself throws a SecurityError when storage is blocked
 * (privacy modes, sandboxed frames), so even reading the property is guarded.
 * The Workspace hint is advisory: without storage the API still works.
 */
export function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

