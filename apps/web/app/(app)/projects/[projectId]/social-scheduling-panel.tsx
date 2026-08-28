"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, CalendarClock, Check, Send, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { DateTimePicker } from "@narriflow/ui/components/date-picker";
import { Spinner } from "@narriflow/ui/components/spinner";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import {
  socialPostSnapshotSchema,
  USER_ERROR_MESSAGES,
  type ClipAspectRatio,
  type ClipSnapshot,
  type SocialAccountSnapshot,
  type SocialPlatform,
  type SocialPostSnapshot,
} from "@narriflow/validators";
import { formatDateTime } from "@/lib/format";
import { createPublicationIntentKeyStore } from "@/lib/publication-intent-key";
import {
  describeSocialPost,
  isLiveSocialPost,
  socialPollDelayMs,
  SOCIAL_PLATFORM_LABELS as platformLabels,
  type SocialPostTone,
} from "@/lib/social-post-status";

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

const toneStripe: Record<SocialPostTone, string> = {
  neutral: "border.emphasized",
  accent: "accent.solid",
  success: "success.solid",
  warning: "warning.solid",
  danger: "danger.solid",
};

const toneFg: Record<SocialPostTone, string> = {
  neutral: "fg.muted",
  accent: "accent.fg",
  success: "success.fg",
  warning: "warning.fg",
  danger: "danger.fg",
};

type Notice = { tone: "success" | "danger"; text: string };

/** Prefers mapped copy for a known error code, falls back to the API's own
 *  message, then to a caller-supplied default. */
function actionErrorText(
  payload: { error?: string; message?: string } | null,
  fallback: string,
): string {
  const mapped = payload?.error ? USER_ERROR_MESSAGES[payload.error] : undefined;
  return mapped ?? payload?.message ?? fallback;
}

const platformItems = platforms.map((value) => ({
  value,
  label: platformLabels[value],
}));

function preferredAspectRatio(clip: ClipSnapshot): ClipAspectRatio {
  return clip.renderVariants.find((render) => render.hasAsset)?.aspectRatio ?? "9:16";
}

export function SocialSchedulingPanel({
  projectId,
  clips,
  posts,
  accounts,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  posts: SocialPostSnapshot[];
  accounts: SocialAccountSnapshot[];
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
  const [submitting, setSubmitting] = useState(false);
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
  const statusesRef = useRef(
    new Map(posts.map((post) => [post.id, post.status])),
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
        if (!isLiveSocialPost(post.status)) {
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
    statusesRef.current = new Map(
      reconciled.map((post) => [post.id, post.status]),
    );
  }, [posts, reconcileWithSettled]);

  useEffect(() => {
    livePostsRef.current = livePosts;
  }, [livePosts]);

  const hasLivePosts = livePosts.some((post) => isLiveSocialPost(post.status));

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
        const previous = statusesRef.current.get(post.id);
        if (isLiveSocialPost(post.status)) continue;
        settledRef.current.set(post.id, post);
        if (previous !== undefined && isLiveSocialPost(previous)) {
          anySettled = true;
        }
      }
      statusesRef.current = new Map(next.map((post) => [post.id, post.status]));
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
        console.error("social_posts_poll_failed", error);
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
        : platformAccounts[0]?.id ?? "",
    );
  }, [platformAccounts]);

  async function schedulePost() {
    if (submitting) {
      return;
    }
    if (!selectedClip) {
      setNotice({ tone: "danger", text: "Choose a clip before scheduling it." });
      return;
    }
    if (!selectedAccount) {
      setNotice({
        tone: "danger",
        text: `Connect a ${platformLabels[platform]} account before scheduling.`,
      });
      return;
    }
    const aspectRatio = preferredAspectRatio(selectedClip);
    const selectedRender = selectedClip.renderVariants.find(
      (render) => render.aspectRatio === aspectRatio,
    );
    const scheduledAt = scheduledFor
      ? new Date(scheduledFor)
      : new Date(Date.now() + 10_000);
    const resolution = selectedRender?.resolution ?? "1080p";
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
      providerSettings: {},
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
          providerSettings: {},
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        console.error("schedule_post_failed", response.status, payload);
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
      console.error("schedule_post_failed", err);
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
        console.error("cancel_post_failed", response.status, payload);
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
      const cancelled = socialPostSnapshotSchema.safeParse(await response.json());
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
      console.error("cancel_post_failed", err);
      setNotice({
        tone: "danger",
        text: "Could not cancel this post. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Box>
          <Text textStyle="eyebrow" color="fg.subtle">
            Social schedule
          </Text>
          <Text mt="0.5" fontSize="xs" color="fg.muted">
          Freeze a clip revision, caption, account, and delivery settings before publication.
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
              onValueChange={(value) => setPlatform(value as SocialPlatform)}
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
              onChange={(event) => setCaption(event.target.value)}
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
              w={{ base: "full", lg: "auto" }}
              disabled={
                isPending ||
                submitting ||
                clips.length === 0 ||
                !caption.trim() ||
                !selectedAccount
              }
              onClick={schedulePost}
            >
              {submitting ? <Spinner size="xs" /> : <CalendarClock size={14} />}
              <Text ms="1.5">{submitting ? "Scheduling…" : "Schedule"}</Text>
            </Button>
          </Box>
        </Grid>

        {notice ? (
          <Flex
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
            gap="0"
            borderTopWidth="1px"
            borderColor="border.subtle"
            aria-live="polite"
          >
            {livePosts.map((post) => {
              const feedback = describeSocialPost(post, nowMs);
              return (
              <Flex
                key={post.id}
                position="relative"
                align="center"
                justify="space-between"
                gap="3"
                ps="3.5"
                pe="1"
                py="2.5"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                transition="background 120ms ease"
                _hover={{ bg: "bg.subtle" }}
              >
                {/* 3px status stripe */}
                <Box
                  position="absolute"
                  insetInlineStart="0"
                  top="0"
                  bottom="0"
                  w="3px"
                  bg={toneStripe[feedback.tone]}
                />
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
                </Box>
                {post.status === "preparing_video" || post.status === "scheduled" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    flexShrink={0}
                    disabled={isPending || submitting}
                    onClick={() => cancelPost(post.id)}
                  >
                    <X size={12} />
                    <Text ms="1">Cancel</Text>
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
          description="Schedule a clip to a connected account — Narriflow prepares the exact frozen video and lists its outcome here."
            ratio={9 / 16}
          />
        )}
      </Stack>
    </Box>
  );
}
