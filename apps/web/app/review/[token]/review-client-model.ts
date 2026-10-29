import { createElement, type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from "react";
import { createApiQueryClient, sha256Hex } from "@narriflow/api-client/core";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReviewMediaGrant, ReviewSession } from "@narriflow/validators/api/reviews";

/** A separate, memory-only cache; guest pages never depend on Clerk bootstrap. */
export function ReviewQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createApiQueryClient);
  useEffect(() => () => client.clear(), [client]);
  return createElement(QueryClientProvider, { client }, children);
}

export function reviewApiOrigin(): string {
  const origin = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!origin) throw new Error("NEXT_PUBLIC_API_URL is required for review pages");
  return new URL(origin).origin;
}

export function useReviewTokenDigest(token: string): string | null {
  const [hashed, setHashed] = useState<{ token: string; digest: string } | null>(null);
  useEffect(() => {
    let active = true;
    void sha256Hex(token).then((digest) => { if (active) setHashed({ token, digest }); });
    return () => { active = false; };
  }, [token]);
  return hashed?.token === token ? hashed.digest : null;
}

export function reviewSessionKey(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError("Review storage requires a token digest");
  return `nf-review-session:${digest}`;
}

export function readReviewSession(storage: Pick<Storage, "getItem" | "removeItem">, digest: string, now = Date.now()): ReviewSession | null {
  const key = reviewSessionKey(digest);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "sessionToken" in value && typeof value.sessionToken === "string" && value.sessionToken && "expiresAt" in value && typeof value.expiresAt === "string" && Date.parse(value.expiresAt) > now) {
      return { sessionToken: value.sessionToken, expiresAt: value.expiresAt };
    }
  } catch { /* An unavailable or malformed tab store cannot authorize access. */ }
  try { storage.removeItem(key); } catch { /* Storage may be disabled. */ }
  return null;
}

export function grantRefreshDelay(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Date.parse(expiresAt) - now - 30_000);
}

/** Refresh cached grants by their advertised expiry. Mounted playback owns its URL. */
export function useExpiringReviewGrant(expiresAt: string | undefined, refetch: () => Promise<unknown>): void {
  useEffect(() => {
    if (!expiresAt) return;
    const refresh = () => { void refetch(); };
    const resume = () => {
      if (document.visibilityState === "visible" && grantRefreshDelay(expiresAt) === 0) refresh();
    };
    const renewal = window.setTimeout(refresh, grantRefreshDelay(expiresAt));
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(renewal);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [expiresAt, refetch]);
}

/** One mounted item/variant/mode keeps its URL, even after a background grant refresh. */
export function useReviewPlayback(
  grant: ReviewMediaGrant | undefined,
  refreshGrant: () => Promise<ReviewMediaGrant>,
  onGrantError?: (reason: unknown) => void,
) {
  const [selected, setSelected] = useState(grant);
  const current = selected ?? grant;
  const currentRef = useRef(current);
  const mounted = useRef(true);
  const renewing = useRef(false);
  const restore = useRef<{ time: number; play: boolean } | null>(null);
  useEffect(() => {
    if (!selected && grant) setSelected(grant);
  }, [grant, selected]);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function renew(video: HTMLVideoElement) {
    if (renewing.current) return;
    renewing.current = true;
    const position = { time: video.currentTime, play: !video.paused };
    video.pause();
    try {
      const next = await refreshGrant();
      if (!mounted.current) return;
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error("This media link has expired. Try playing again.");
      currentRef.current = next;
      if (next.url !== video.getAttribute("src")) {
        restore.current = position;
        setSelected(next);
      } else {
        setSelected(next);
        if (position.play) void video.play().catch(() => undefined);
      }
    } catch (reason) {
      if (mounted.current) onGrantError?.(reason);
    } finally {
      renewing.current = false;
    }
  }

  function renewExpired(event: SyntheticEvent<HTMLVideoElement>) {
    if (currentRef.current && Date.parse(currentRef.current.expiresAt) <= Date.now()) {
      void renew(event.currentTarget);
    }
  }

  return {
    src: current?.url,
    onPlay: renewExpired,
    onError: renewExpired,
    onLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
      const pending = restore.current;
      if (!pending) return;
      restore.current = null;
      event.currentTarget.currentTime = pending.time;
      if (pending.play) void event.currentTarget.play().catch(() => undefined);
    },
  };
}

export type ReviewCommentTarget = {
  id: string;
  itemId: string | null;
};

export function reviewApprovalProgress(
  items: Array<{ required: boolean; currentDecision: string | null }>,
  approvalRequired: boolean,
) {
  const required = items.filter((item) => item.required);
  const approved = required.filter((item) => item.currentDecision === "approved").length;
  return {
    approved,
    required: required.length,
    ready: !approvalRequired || approved === required.length,
  };
}

export function buildReviewCommentPayload(input: {
  body: string;
  activeItemId: string | null;
  parent: ReviewCommentTarget | null;
  scope: "clip" | "round";
  includeTimecode: boolean;
  currentTimeSec: number | null;
}) {
  const itemId = input.parent?.itemId ?? (input.scope === "round" ? null : input.activeItemId);
  const timestampSec = input.parent || input.scope === "round" || !input.includeTimecode || !itemId
    ? null
    : input.currentTimeSec;
  return {
    itemId,
    parentId: input.parent?.id ?? null,
    body: input.body.trim(),
    timestampSec,
  };
}
