"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { identifyAnalytics, resetAnalytics } from "@/lib/analytics";

/** Links events to the opaque Clerk ID, never to an email or name. Runs signed out
 * too, so a shared device that loads after sign-out stops using the last person's ID. */
export function AnalyticsIdentity() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    if (userId) identifyAnalytics(userId);
    else resetAnalytics();
  }, [isLoaded, userId]);
  return null;
}
