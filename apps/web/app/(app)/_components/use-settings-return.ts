"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { settingsReturnState, type SettingsReturnState } from "@/lib/settings-return";

const storageKey = "narriflow.settings-return";

export function useSettingsReturn(workspaceId: string) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const state = useRef<SettingsReturnState | null>(null);
  const [href, setHref] = useState("/home");
  useEffect(() => {
    if (!state.current) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (typeof saved?.workspaceId === "string" && typeof saved?.destination === "string") state.current = saved;
      } catch { /* Storage may be unavailable; in-memory navigation still works. */ }
    }
    state.current = settingsReturnState(state.current, workspaceId, pathname + (search ? `?${search}` : ""));
    setHref(state.current.destination);
    try { sessionStorage.setItem(storageKey, JSON.stringify(state.current)); } catch { /* Storage is optional. */ }
  }, [pathname, search, workspaceId]);
  return href;
}
