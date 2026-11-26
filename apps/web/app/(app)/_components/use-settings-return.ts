"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { settingsReturnState, type SettingsReturnState } from "@/lib/settings-return";

const storageKey = "narriflow.settings-return";

/**
 * Remembers where settings' Back goes: the last page outside settings in this
 * Workspace, reported with the Workspace it belongs to. It reads the URL, so
 * render it inside a Suspense boundary. When it mounts it first takes the page
 * left while the Workspace was opening, which it could not see.
 */
export function SettingsReturnTracker({ workspaceId, takePendingVisit, onChange }: {
  workspaceId: string;
  takePendingVisit: () => string | null;
  onChange: (state: SettingsReturnState) => void;
}) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const state = useRef<SettingsReturnState | null>(null);
  useEffect(() => {
    if (!state.current) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (typeof saved?.workspaceId === "string" && typeof saved?.destination === "string") state.current = saved;
      } catch { /* Storage may be unavailable; in-memory navigation still works. */ }
    }
    const visit = takePendingVisit();
    // The visit happened in the Workspace now opening; a saved state for another one must not void it.
    if (visit) state.current = settingsReturnState(state.current?.workspaceId === workspaceId ? state.current : null, workspaceId, visit);
    state.current = settingsReturnState(state.current, workspaceId, pathname + (search ? `?${search}` : ""));
    onChange(state.current);
    try { sessionStorage.setItem(storageKey, JSON.stringify(state.current)); } catch { /* Storage is optional. */ }
  }, [pathname, search, workspaceId, takePendingVisit, onChange]);
  return null;
}
