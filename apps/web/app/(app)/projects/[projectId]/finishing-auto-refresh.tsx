"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Finishing writes no Project events, so a page showing it as working looks
 * again every so often until it ends. */
export function FinishingAutoRefresh({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
