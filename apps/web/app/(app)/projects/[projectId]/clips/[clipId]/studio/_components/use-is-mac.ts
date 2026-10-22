"use client";

import { useEffect, useState } from "react";

/**
 * True on Apple platforms, where shortcuts use ⌘ instead of Ctrl. Starts
 * false so the server render and first client render agree.
 */
export function useIsMac() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}
