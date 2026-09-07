"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, CalendarClock, Check, CheckCircle2, RefreshCw, Repeat2, Send, X,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { DateTimePicker } from "@narriflow/ui/components/date-picker";
import { Spinner } from "@narriflow/ui/components/spinner";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import {
  socialPostSnapshotSchema,
  SOCIAL_PROVIDER_CAPABILITIES,
  USER_ERROR_MESSAGES,
  type ClipAspectRatio,
  type ClipSnapshot,
  type SocialAccountSnapshot,
  type SocialPlatform,
  type SocialPostSnapshot,
} from "@narriflow/validators";
import { formatDateTime } from "@/lib/format";
import { createPublicationIntentKeyStore } from "@/lib/publication-intent-key";
import { authenticatedRequestFailureMessage } from "@/lib/authenticated-request-browser";
import {
  describeSocialPost,
  isLiveSocialPostSnapshot,
  socialPollDelayMs,
  SOCIAL_PLATFORM_LABELS as platformLabels,
  type SocialPostTone,
} from "@/lib/social-post-status";
import {
  ReviewApprovalCheckpoint,
  reviewApprovalOverrideReady,
  reviewOverrideReasonForRequest,
} from "../../_components/review-approval-checkpoint";
import { AssistedPublishingWorkspace } from "./assisted-publishing-workspace";

const platforms = Object.keys(platformLabels) as SocialPlatform[];

const socialPostListSchema = socialPostSnapshotSchema.array();

/** Re-check the list this soon after a backgrounded tab comes back, and after
 *  a failed poll — both cases want a prompt retry without a tight loop. */
const RECOVERY_POLL_DELAY_MS = 5_000;
/** Consecutive poll failures before the panel admits its status may be stale.
 *  One transient failure is invisible; a broken connection is not. */
const STALE_AFTER_FAILURES = 2;
/** Countdown copy is minute-grained, so a coarse tick is plenty. */
const CLOCK_TICK_MS = 15_000;


const toneFg: Record<SocialPostTone, string> = {
  neutral: "fg.muted",
  accent: "accent.fg",
  success: "success.fg",
  warning: "warning.fg",
  danger: "danger.fg",
};

type Notice = { tone: "success" | "danger"; text: string };
type RecoveryAction = "recheck" | "confirm_published" | "publish_again";
type RecoveryForm = {
  postId: string;
  action: RecoveryAction;
  evidenceKind: "provider_reference" | "platform_url" | "manual_unvalidated";
  reason: string;
  externalUrl: string;
  providerReference: string;
  duplicateRiskAcknowledged: boolean;
};

/** Prefers mapped copy for a known error code, falls back to the API's own
 *  message, then to a caller-supplied default. */
function actionErrorText(
  payload: { error?: string; message?: string } | null,
  fallback: string,
): string {
  const mapped = payload?.error ? USER_ERROR_MESSAGES[payload.error] : undefined;
  return (
    mapped ??
    authenticatedRequestFailureMessage(
      payload?? {},
      typeof window === "undefined"
        ? "/calendar"
        : `${window.location.pathname}${window.location.search}`,
      fallback,
    )
  );
}

const platformItems = platforms.map((value) => ({
  value,
  label: platformLabels[value],
}));

const platformPostUrlExamples: Record<SocialPlatform, string> = {
  youtube_shorts: "https://youtube.com/shorts/…",
  instagram_reels: "https://instagram.com/reel/…",
  facebook_reels: "https://facebook.com/reel/…",
  tiktok: "https://tiktok.com/@creator/video/…",
  linkedin: "https://linkedin.com/feed/update/…",
  x: "https://x.com/creator/status/…",
};

const duplicateRiskCopy: Record<SocialPlatform, string> = {
  youtube_shorts:
    "The earlier YouTube upload could have completed. Publishing again may create a second Short.",
  instagram_reels:
    "The earlier Instagram container could already be published. Publishing again may create a second Reel.",
  facebook_reels:
    "The earlier Facebook upload could already be published. Publishing again may create a second Reel.",
  tiktok:
    "The earlier TikTok direct post could still finish moderation. Publishing again may create a second video.",
  linkedin:
    "LinkedIn could not prove the earlier Post outcome. Publishing again may create a second video Post.",
  x: "X could not prove the earlier Post outcome. Publishing again may create a second Post.",
};

function preferredAspectRatio(clip: ClipSnapshot, platform: SocialPlatform): ClipAspectRatio | null {
  const supported = SOCIAL_PROVIDER_CAPABILITIES[platform].aspectRatios as readonly string[];
  return (
    clip.renderVariants.find((render) => render.hasAsset && supported.includes(render.aspectRatio))?.aspectRatio ?? null
  );
}

export function SocialSchedulingPanel({
  projectId,
  clips,
  posts,
  accounts,
  facebookPublishingEnabled,
  canOverrideReview,
  workspaceTimezone,
  assistedCopyEnabled,
  customThumbnailsEnabled,
  campaignSchedulingEnabled,
  canUploadVisualAssets,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  posts: SocialPostSnapshot[];
  accounts: SocialAccountSnapshot[];
  facebookPublishingEnabled: boolean;
  canOverrideReview: boolean;
  workspaceTimezone: string;
  assistedCopyEnabled: boolean;
  customThumbnailsEnabled: boolean;
  campaignSchedulingEnabled: boolean;
  canUploadVisualAssets: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [clipId, setClipId] = useState(clips[0]?.id ?? "");
  const selectedClip = clips.find((clip) => clip.id === clipId) ?? null;
  const [platform, setPlatform] = useState<SocialPlatform>("tiktok");
  const platformAccounts = useMemo(
    () =>
      accounts.filter(
        (account) => account.platform === platform && account.status === "active",
      ),
    [accounts, platform],
  );
  const [accountId, setAccountId] = useState("");
  const [caption, setCaption] = useState(selectedClip?.hookText ?? "");
  const [scheduledFor, setScheduledFor] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [approvalBlocked, setApprovalBlocked] = useState(false);
  const [reviewOverrideReason, setReviewOverrideReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recoveryForm, setRecoveryForm] = useState<RecoveryForm | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const selectedAccount =
    platformAccounts.find((account) => account.id === accountId) ?? null;

  // --- Live post state -----------------------------------------------------
  // Publishing happens in the worker, which has no SSE channel of its own (the
  // project stream only carries pipeline `workflow.stage.updated` events). So
  // the panel polls its own list while the worker owns a post, and refreshes
  // the server tree once a post reaches a terminal status so the rest of the
  // workspace (analytics, activity) catches up too.
  const [livePosts, setLivePosts] = useState(posts);
  const [statusStale, setStatusStale] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const livePostsRef = useRef(livePosts);
  const livenessRef = useRef(
    new Map(posts.map((post) => [post.id, isLiveSocialPostSnapshot(post)])),
  );
  /** Posts this client already saw reach a terminal status. A `router.refresh()`
   *  can land before the server render reflects the same write, and letting a
   *  stale "scheduled" overwrite a settled "posted" would both regress the row
   *  and restart polling on an already-finished post. */
  const settledRef = useRef(new Map<string, SocialPostSnapshot>());

  /** Server snapshot, with any post the server still reports as live replaced
   *  by the terminal snapshot this client already confirmed. */
  const reconcileWithSettled = useCallback(
    (incoming: SocialPostSnapshot[]): SocialPostSnapshot[] =>
      incoming.map((post) => {
        const settled = settledRef.current.get(post.id);
        if (!settled) return post;
        if (!isLiveSocialPostSnapshot(post)) {
          settledRef.current.delete(post.id);
          return post;
        }
        return settled;
      }),
    [],
  );

  useEffect(() => {
    const reconciled = reconcileWithSettled(posts);
    setLivePosts(reconciled);
    livenessRef.current = new Map(
      reconciled.map((post) => [post.id, isLiveSocialPostSnapshot(post)]),
    );
  }, [posts, reconcileWithSettled]);

  useEffect(() => {
    livePostsRef.current = livePosts;
  }, [livePosts]);

  const hasLivePosts = livePosts.some(isLiveSocialPostSnapshot);

  // Relative phrasing ("in 12 min") is client-only: `nowMs` stays null through
  // SSR and the first render, so the markup can't mismatch on hydration.
  useEffect(() => {
    setNowMs(Date.now());
    if (!hasLivePosts) return;
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [hasLivePosts]);

  const applyPosts = useCallback(
    (next: SocialPostSnapshot[]) => {
      let anySettled = false;
      for (const post of next) {
        const previousWasLive = livenessRef.current.get(post.id);
        if (isLiveSocialPostSnapshot(post)) continue;
        settledRef.current.set(post.id, post);
        if (previousWasLive) {
          anySettled = true;
        }
      }
      livenessRef.current = new Map(
        next.map((post) => [post.id, isLiveSocialPostSnapshot(post)]),
      );
      setLivePosts(next);
      // A post reaching its terminal status is also new analytics + activity
      // data, so pull the rest of the workspace forward once.
      if (anySettled) router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (!hasLivePosts) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const queueNext = (from: SocialPostSnapshot[]) => {
      if (stopped) return;
      const delay = socialPollDelayMs(from, Date.now());
      if (delay === null) return;
      timer = setTimeout(
        poll,
        failures > 0 ? Math.max(delay, RECOVERY_POLL_DELAY_MS) : delay,
      );
    };

    const poll = async () => {
      if (stopped) return;
      // Nothing to show a hidden tab — resume on visibilitychange below.
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, RECOVERY_POLL_DELAY_MS);
        return;
      }
      try {
        const response = await fetch(
          `/api/projects/${projectId}/social-posts`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`http_${response.status}`);
        const payload = (await response.json()) as { posts?: unknown };
        const parsed = socialPostListSchema.safeParse(payload.posts);
        if (!parsed.success) throw new Error("invalid_payload");
        if (stopped) return;
        failures = 0;
        setStatusStale(false);
        setNowMs(Date.now());
        applyPosts(parsed.data);
        queueNext(parsed.data);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        console.warn(JSON.stringify({ level: "error", message: "social_posts_poll_failed", errorName: error instanceof Error ? error.name : "UnknownError" }));
        if (failures >= STALE_AFTER_FAILURES) setStatusStale(true);
        queueNext(livePostsRef.current);
      }
    };

    const onVisibilityChange = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll();
    };

    queueNext(livePostsRef.current);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [projectId, hasLivePosts, applyPosts]);

  const clipItems = useMemo(
    () =>
      clips.length === 0
        ? [{ value: "", label: "No clips", disabled: true }]
        : clips.map((clip) => ({
            value: clip.id,
            label: `Clip ${clip.index + 1}`,
          })),
    [clips],
  );
  const accountItems = useMemo(
    () =>
      platformAccounts.length === 0
        ? [{ value: "", label: "No connected account", disabled: true }]
        : platformAccounts.map((account) => ({
            value: account.id,
            label: `${account.displayName}${account.handle ? ` (${account.handle})` : ""}`,
          })),
    [platformAccounts],
  );

  useEffect(() => {
    setAccountId((current) =>
      platformAccounts.some((account) => account.id === current)
        ? current
        : (platformAccounts[0]?.id ?? ""),
    );
  }, [platformAccounts]);

  async function schedulePost() {
    if (submitting) {
      return;
    }
    if (!selectedClip) {
      setNotice({ tone: "danger", text: "Choose a clip before scheduling it.",
      });
      return;
    }
    if (!selectedAccount) {
      setNotice({
        tone: "danger",
        text: `Connect a ${platformLabels[platform]} account before scheduling.`,
      });
      return;
    }
    const aspectRatio = preferredAspectRatio(selectedClip, platform);
    if (!aspectRatio) {
      setNotice({ tone: "danger", text: `${platformLabels[platform]} does not support any ready aspect ratio for this clip.` });
      return;
    }
    const selectedRender = selectedClip.renderVariants.find(
      (render) => render.aspectRatio === aspectRatio,
    );
    const scheduledAt = scheduledFor
      ? new Date(scheduledFor)
      : new Date(Date.now() + 10_000);
    const resolution = selectedRender?.resolution ?? "1080p";
	const providerSettings =
		platform === "tiktok"
			? {
					tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
					disableComment: false,
					disableDuet: false,
					disableStitch: false,
					videoCoverTimestampMs: 1_000,
					isAigc: false,
				}
			: {};
    const request = {
      projectId,
      clipId: selectedClip.id,
      editorRevision: selectedClip.editorRevision,
      accountId: selectedAccount.id,
      platform,
      caption,
      aspectRatio,
      resolution,
      scheduledFor: scheduledAt.toISOString(),
      providerSettings,
      reviewOverrideReason: reviewOverrideReasonForRequest({
        blocked: approvalBlocked,
        canOverride: canOverrideReview,
        reason: reviewOverrideReason,
      }),
    };
    const intentKeys = createPublicationIntentKeyStore({
      storage: window.sessionStorage,
      createId: () => crypto.randomUUID(),
    });
    const clientIdempotencyKey = intentKeys.forRequest(request);
    setNotice(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/social-posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientIdempotencyKey,
          clipId: selectedClip.id,
          expectedEditorRevision: selectedClip.editorRevision,
          accountId: selectedAccount.id,
          platform,
          caption,
          aspectRatio,
          resolution,
          scheduledFor: scheduledAt.toISOString(),
          providerSettings,
          reviewOverrideReason: request.reviewOverrideReason,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        if (payload?.error === "review_approval_required") {
			setApprovalBlocked(true);
			setNotice(null);
			requestAnimationFrame(() => noticeRef.current?.focus());
			return;
		}
        console.warn(JSON.stringify({ level: "error", message: "schedule_post_failed", status: response.status }));
        setNotice({
          tone: "danger",
          text: actionErrorText(payload, "Could not schedule post."),
        });
        return;
      }
      const created = socialPostSnapshotSchema.safeParse(await response.json());
      if (!created.success) {
        throw new Error("The scheduling response was incomplete");
      }
      intentKeys.confirm(request);
      setApprovalBlocked(false);
      setReviewOverrideReason("");
      setNotice({
        tone: "success",
        text: scheduledFor
          ? `Scheduled to ${platformLabels[platform]} for ${formatDateTime(scheduledFor)}.`
          : `Queued to ${platformLabels[platform]} — publishing now.`,
      });
      // Show the new row immediately; the refresh below reconciles the rest of
      // the server tree (and the poll loop takes over from here).
      applyPosts([...livePostsRef.current, created.data]);
      startTransition(() => router.refresh());
    } catch (err) {
      console.warn(JSON.stringify({ level: "error", message: "schedule_post_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
      setNotice({
        tone: "danger",
        text: "Could not schedule post. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelPost(postId: string) {
    if (submitting) {
      return;
    }
    setNotice(null);
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/social-posts/${postId}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        console.warn(JSON.stringify({ level: "error", message: "cancel_post_failed", status: response.status }));
        setNotice({
          tone: "danger",
          text: actionErrorText(
            payload,
            "Could not cancel this post. Please try again.",
          ),
        });
        // The usual cause is the worker claiming the post mid-click — pull the
        // real status back so the row stops offering a cancel that can't work.
        startTransition(() => router.refresh());
        return;
      }
      const cancelled = socialPostSnapshotSchema.safeParse(await response.json(),
      );
      if (cancelled.success) {
        applyPosts(
          livePostsRef.current.map((post) =>
            post.id === cancelled.data.id ? cancelled.data : post,
          ),
        );
      }
      setNotice({ tone: "success", text: "Post canceled." });
      startTransition(() => router.refresh());
    } catch (err) {
      console.warn(JSON.stringify({ level: "error", message: "cancel_post_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
      setNotice({
        tone: "danger",
        text: "Could not cancel this post. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRecovery(post: SocialPostSnapshot) {
    if (!recoveryForm || recoveryForm.postId !== post.id || submitting) return;
    const reason = recoveryForm.reason.trim();
    if (!reason) {
      setNotice({ tone: "danger", text: "Add a short audit reason before continuing.",
      });
      return;
    }
    if (
      recoveryForm.action === "publish_again" &&
      !recoveryForm.duplicateRiskAcknowledged
    ) {
      setNotice({
        tone: "danger",
        text: `Acknowledge that another ${platformLabels[post.platform]} post may already be live.`,
      });
      return;
    }
    const endpoint =
      recoveryForm.action === "recheck"
        ? "recheck"
        : recoveryForm.action === "confirm_published"
          ? "confirm"
          : "publish-again";
    const body =
      recoveryForm.action === "recheck"
        ? { reason }
        : recoveryForm.action === "confirm_published"
          ? {
              reason,
              evidenceKind: recoveryForm.evidenceKind,
              externalUrl: recoveryForm.externalUrl.trim() || null,
              providerReference: recoveryForm.providerReference.trim() || null,
            }
          : { reason, duplicateRiskAcknowledged: true };
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/social-posts/${post.id}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
        ownershipValidated?: boolean;
      } | null;
      if (!response.ok) {
        setNotice({
          tone: "danger",
          text: actionErrorText(payload, "The publication changed before this action completed.",
          ),
        });
        startTransition(() => router.refresh());
        return;
      }
      const text =
        recoveryForm.action === "recheck"
          ? `Checking the existing ${platformLabels[post.platform]} operation. Nothing was submitted again.`
          : recoveryForm.action === "confirm_published"
            ? payload?.ownershipValidated
              ? "Marked published after validating the post belongs to this connected account."
              : "Marked published with unvalidated manual evidence."
            : `A linked ${platformLabels[post.platform]} attempt was scheduled with the duplicate risk recorded.`;
      setRecoveryForm(null);
      settledRef.current.delete(post.id);
      setNotice({ tone: "success", text });
      requestAnimationFrame(() => noticeRef.current?.focus());
      startTransition(() => router.refresh());
    } catch {
      setNotice({ tone: "danger", text: "Could not complete the recovery action.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box id="social-publishing" layerStyle="band">
      <Stack gap="4">
        <AssistedPublishingWorkspace
          projectId={projectId}
          clips={clips}
          accounts={accounts}
          workspaceTimezone={workspaceTimezone}
          assistedCopyEnabled={assistedCopyEnabled}
          customThumbnailsEnabled={customThumbnailsEnabled}
          campaignSchedulingEnabled={campaignSchedulingEnabled}
          canUploadVisualAssets={canUploadVisualAssets}
          facebookPublishingEnabled={facebookPublishingEnabled}
			canOverrideReview={canOverrideReview}
          onScheduled={() => startTransition(() => router.refresh())}
        />

        <Box>
          <Text textStyle="eyebrow" color="fg.subtle">
            Manual post
          </Text>
          <Text mt="0.5" fontSize="xs" color="fg.muted">
            Schedule one exact caption without assisted copy.
          </Text>
        </Box>

        <Grid
          templateColumns={{
            base: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(3, minmax(0, 1fr))",
          }}
          gap="3"
          alignItems="end"
        >
          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Clip
            </Text>
            <Select
              items={clipItems}
              value={clipId}
              onValueChange={(nextId) => {
                setClipId(nextId);
                setApprovalBlocked(false);
                setReviewOverrideReason("");
                const nextClip = clips.find((clip) => clip.id === nextId);
                if (nextClip) setCaption(nextClip.hookText);
              }}
              size="sm"
              placeholder="No clips"
              disabled={clips.length === 0}
              aria-label="Clip to publish"
            />
          </Box>

          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Platform
            </Text>
            <Select
              items={platformItems}
              value={platform}
              onValueChange={(value) => {
                setPlatform(value as SocialPlatform);
                setApprovalBlocked(false);
                setReviewOverrideReason("");
              }}
              size="sm"
              aria-label="Platform"
            />
          </Box>

          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Account
            </Text>
            <Select
              items={accountItems}
              value={accountId}
              onValueChange={setAccountId}
              size="sm"
              placeholder="No connected account"
              disabled={platformAccounts.length === 0}
              aria-label="Account"
            />
          </Box>

          <Box gridColumn={{ sm: "span 2", lg: "span 1" }}>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Caption
            </Text>
            <Input
              size="sm"
              value={caption}
              maxLength={SOCIAL_PROVIDER_CAPABILITIES[platform].textLimit}
              onChange={(event) => setCaption(event.target.value.slice(0, SOCIAL_PROVIDER_CAPABILITIES[platform].textLimit))}
            />
          </Box>

          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Scheduled time
            </Text>
            <DateTimePicker
              ariaLabel="Scheduled date and time"
              value={scheduledFor}
              onValueChange={setScheduledFor}
            />
          </Box>

          <Box>
            <Button
              size="sm"
              variant="outline"
              w={{ base: "full", lg: "auto" }}
              disabled={
                isPending ||
                submitting ||
                clips.length === 0 ||
                !caption.trim() ||
                !selectedAccount ||
                !reviewApprovalOverrideReady({
                  blocked: approvalBlocked,
                  canOverride: canOverrideReview,
                  reason: reviewOverrideReason,
                }) ||
                !(platform === "facebook_reels" ? facebookPublishingEnabled : SOCIAL_PROVIDER_CAPABILITIES[platform].publishingEnabledByDefault)
              }
              onClick={schedulePost}
            >
              {submitting ? <Spinner size="xs" /> : <CalendarClock size={14} />}
              <Text ms="1.5">{submitting ? "Scheduling…" : approvalBlocked ? "Override & schedule" : "Schedule"}</Text>
            </Button>
          </Box>
        </Grid>

        {approvalBlocked ? (
          <Box
            ref={noticeRef}
            tabIndex={-1}
          >
            <ReviewApprovalCheckpoint
              projectId={projectId}
              canOverride={canOverrideReview}
              reason={reviewOverrideReason}
              onReasonChange={setReviewOverrideReason}
              inputId="review-override-reason"
            />
          </Box>
        ) : null}

        {notice ? (
          <Flex
            ref={noticeRef}
            tabIndex={-1}
            align="center"
            gap="1.5"
            color={notice.tone === "success" ? "success.fg" : "danger.fg"}
            role="status"
            aria-live="polite"
          >
            {notice.tone === "success" ? (
              <Check size={13} aria-hidden />
            ) : (
              <AlertTriangle size={13} aria-hidden />
            )}
            <Text fontSize="xs">{notice.text}</Text>
          </Flex>
        ) : null}

        {statusStale ? (
          <Flex align="center" gap="1.5" color="warning.fg">
            <AlertTriangle size={13} aria-hidden />
            <Text fontSize="xs">
              Live publish status isn&apos;t updating right now — reload the page
              to see where these posts stand.
            </Text>
          </Flex>
        ) : null}

        {platformAccounts.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">
            <Link href="/settings/social-accounts">
              <Text
                as="span"
                color="fg"
                textDecoration="underline"
                textDecorationColor="border.emphasized"
                textUnderlineOffset="3px"
                transition="text-decoration-color 120ms ease"
                _hover={{ textDecorationColor: "fg" }}
              >
                Connect social accounts
              </Text>
            </Link>{" "}
            to publish directly from Narriflow.
          </Text>
        ) : null}

        {livePosts.length > 0 ? (
          <Stack
            gap="3"
            aria-live="polite"
          >
            {livePosts.map((post) => {
              const feedback = describeSocialPost(post, nowMs);
              return (
              <Flex
                key={post.id}
                position="relative"
                direction={{ base: "column", md: "row" }}
                align={{ base: "stretch", md: "center" }}
                justify="space-between"
                gap="3"
                p="4"
                bg="bg.panel"
                borderRadius="l2"
                borderWidth="1px"
                borderColor="border.subtle"
                transition="background 120ms ease"
                _hover={{ bg: "bg.subtle" }}
              >
                <Box minW="0">
                  <Flex align="center" gap="2" wrap="wrap">
                    <Text fontSize="13px" fontWeight="500" color="fg" truncate>
                      {platformLabels[post.platform]}
                      {post.accountDisplayName ? ` · ${post.accountDisplayName}` : ""}
                    </Text>
                    <Flex align="center" gap="1.5">
                      {feedback.isBusy ? <Spinner size="xs" /> : null}
                      <Text textStyle="eyebrow" color={toneFg[feedback.tone]}>
                        {feedback.label}
                      </Text>
                    </Flex>
                  </Flex>
                  <Text fontSize="xs" color="fg.muted" truncate>
                    {feedback.detail}
                  </Text>
                  <Text fontSize="xs" color="fg.subtle" truncate>
                    {post.caption}
                  </Text>
                  {feedback.error ? (
                    <Flex align="center" gap="1.5" color="danger.fg" mt="0.5">
                      <AlertTriangle size={12} aria-hidden />
                      <Text fontSize="xs">{feedback.error}</Text>
                    </Flex>
                  ) : null}
                  {post.latestMetrics ? (
                    <Text textStyle="data" fontSize="11px" color="fg.subtle" truncate>
                      {post.latestMetrics.views} views ·{" "}
                      {post.latestMetrics.likes} likes ·{" "}
                      {post.latestMetrics.comments} comments ·{" "}
                      {post.latestMetrics.shares} shares
                    </Text>
                  ) : null}
                  {post.externalUrl ? (
                    <a href={post.externalUrl} target="_blank" rel="noreferrer">
                      <Text
                        fontSize="11px"
                        color="fg"
                        textDecoration="underline"
                        textDecorationColor="border.emphasized"
                        textUnderlineOffset="3px"
                        transition="text-decoration-color 120ms ease"
                        _hover={{ textDecorationColor: "fg" }}
                        truncate
                      >
                        View on {platformLabels[post.platform]}
                      </Text>
                    </a>
                  ) : null}
                  {recoveryForm?.postId === post.id ? (
                    <Stack
                      mt="2"
                      p="3"
                      gap="2"
                      layerStyle={
                        recoveryForm.action === "publish_again" ? "panel" : "well"
                      }
                      borderStartWidth="3px"
                      borderStartColor="warning.solid"
                    >
                      <Text textStyle="eyebrow" color="warning.fg">
                        {recoveryForm.action === "recheck"
                          ? "Recheck existing operation"
                          : recoveryForm.action === "confirm_published"
                            ? "Confirm published"
                            : `Duplicate risk on ${platformLabels[post.platform]}`}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {recoveryForm.action === "recheck"
                          ? "Narriflow will inspect only the durable provider operation for this attempt."
                          : recoveryForm.action === "confirm_published"
                            ? "Use this only after finding the post on the platform. Add its URL or provider post ID; with neither, the evidence stays labeled manual and unvalidated."
                            : `${duplicateRiskCopy[post.platform]} The uncertain attempt stays in the audit history.`}
                      </Text>
                      <Input
                        size="sm"
                        aria-label="Recovery reason"
                        placeholder="Reason for this action"
                        value={recoveryForm.reason}
                        onChange={(event) =>
                          setRecoveryForm((current) =>
                            current ? { ...current, reason: event.target.value } : current,
                          )
                        }
                      />
                      {recoveryForm.action === "confirm_published" ? (
                        <Select
                          size="sm"
                          aria-label="Confirmation evidence type"
                          items={[
                            {
                              value: "manual_unvalidated",
                              label: "Manual evidence — unvalidated",
                            },
                            {
                              value: "platform_url",
                              label: "Validate a platform URL",
                            },
                            {
                              value: "provider_reference",
                              label: "Validate a provider post ID",
                            },
                          ]}
                          value={recoveryForm.evidenceKind}
                          onValueChange={(value) =>
                            setRecoveryForm((current) =>
                              current
                                ? {
                                    ...current,
                                    evidenceKind: value as RecoveryForm["evidenceKind"],
                                  }
                                : current,
                            )
                          }
                        />
                      ) : null}
                      {recoveryForm.action === "confirm_published" &&
                      recoveryForm.evidenceKind !== "provider_reference" ? (
                        <Input
                          size="sm"
                          type="url"
                          aria-label={`${platformLabels[post.platform]} post URL`}
                          placeholder={platformPostUrlExamples[post.platform]}
                          value={recoveryForm.externalUrl}
                          onChange={(event) =>
                            setRecoveryForm((current) =>
                              current
                                ? {
                                    ...current,
                                    externalUrl: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      ) : null}
                      {recoveryForm.action === "confirm_published" &&
                      recoveryForm.evidenceKind !== "platform_url" ? (
                        <Input
                          size="sm"
                          aria-label={`${platformLabels[post.platform]} provider post ID`}
                          placeholder={
                            post.platform === "instagram_reels"
                              ? "Instagram media ID (numbers only)"
                              : "Provider post ID"
                          }
                          value={recoveryForm.providerReference}
                          onChange={(event) =>
                            setRecoveryForm((current) =>
                              current
                                ? {
                                    ...current,
                                    providerReference: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      ) : null}
                      {recoveryForm.action === "publish_again" ? (
                        <Checkbox
                          alignItems="flex-start"
                          checked={recoveryForm.duplicateRiskAcknowledged}
                          onCheckedChange={(checked) =>
                            setRecoveryForm((current) =>
                              current
                                ? {
                                    ...current,
                                    duplicateRiskAcknowledged: checked,
                                  }
                                : current,
                            )
                          }
                        >
                          I checked {platformLabels[post.platform]} and accept the
                          risk of a duplicate post.
                        </Checkbox>
                      ) : null}
                      <Flex gap="2" justify="flex-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRecoveryForm(null)}
                        >
                          Close
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            submitting ||
                            !recoveryForm.reason.trim() ||
                            (recoveryForm.action === "publish_again" &&
                              !recoveryForm.duplicateRiskAcknowledged)
                          }
                          onClick={() => submitRecovery(post)}
                        >
                          {submitting ? <Spinner size="xs" /> : null}
                          Continue
                        </Button>
                      </Flex>
                    </Stack>
                  ) : null}
                </Box>
                {post.allowedActions.includes("cancel") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    flexShrink={0}
                    disabled={isPending || submitting}
                    onClick={() => cancelPost(post.id)}
                  >
                    <X size={12} />
                    <Text ms="1">Cancel</Text>
                  </Button>
                ) : post.status === "needs_attention" ? (
                  <Flex gap="1" flexShrink={0} wrap="wrap" justify="flex-end">
                    {post.allowedActions.includes("recheck") ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRecoveryForm({
                            postId: post.id,
                            action: "recheck",
                            evidenceKind: "manual_unvalidated",
                            reason: "",
                            externalUrl: "",
                            providerReference: "",
                            duplicateRiskAcknowledged: false,
                          })
                        }
                      >
                        <RefreshCw size={12} /> Recheck
                      </Button>
                    ) : null}
                    {post.allowedActions.includes("confirm_published") ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRecoveryForm({
                            postId: post.id,
                            action: "confirm_published",
                            evidenceKind: "manual_unvalidated",
                            reason: "",
                            externalUrl: "",
                            providerReference: "",
                            duplicateRiskAcknowledged: false,
                          })
                        }
                      >
                        <CheckCircle2 size={12} /> Confirm
                      </Button>
                    ) : null}
                    {post.allowedActions.includes("publish_again") ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        color="warning.fg"
                        onClick={() =>
                          setRecoveryForm({
                            postId: post.id,
                            action: "publish_again",
                            evidenceKind: "manual_unvalidated",
                            reason: "",
                            externalUrl: "",
                            providerReference: "",
                            duplicateRiskAcknowledged: false,
                          })
                        }
                      >
                        <Repeat2 size={12} /> Publish again
                      </Button>
                    ) : null}
                    {post.allowedActions.includes("reconnect_account") ? (
                      <Button size="sm" variant="ghost" asChild>
                        <Link href="/settings/social-accounts">Reconnect</Link>
                      </Button>
                    ) : null}
                  </Flex>
                ) : post.allowedActions.includes("reconnect_account") ? (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href="/settings/social-accounts">Reconnect</Link>
                  </Button>
                ) : null}
              </Flex>
              );
            })}
          </Stack>
        ) : (
          <EmptyState
            icon={<Send size={22} aria-hidden />}
            title="Nothing scheduled yet"
          description="Schedule a clip to a connected account."
            ratio={9 / 16}
          />
        )}
      </Stack>
    </Box>
  );
}
