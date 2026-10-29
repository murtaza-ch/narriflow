/**
 * Browser storage a person leaves behind that only makes sense while they are
 * signed in. Unsaved work is deliberately not listed: Studio Device Drafts
 * live in IndexedDB and Publishing Drafts under `narriflow:publishing:`, so
 * signing out never costs anyone their edits.
 */
const LOCAL_PREFIXES = [
  "narriflow:workspace:",
  "narriflow.checkout.v1:",
  "narriflow:studio-lease:",
  "narriflow:recent-searches:",
] as const;
const SESSION_PREFIXES = ["narriflow.settings-return", "narriflow:campaign-clip-selection:"] as const;

function removeByPrefix(storage: Storage, prefixes: readonly string[]): void {
  try {
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Storage can be blocked; there is nothing further to clear.
  }
}

export function clearSignedInBrowserState(local: Storage, session: Storage): void {
  removeByPrefix(local, LOCAL_PREFIXES);
  removeByPrefix(session, SESSION_PREFIXES);
}
