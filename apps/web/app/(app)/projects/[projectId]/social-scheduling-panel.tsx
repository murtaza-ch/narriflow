"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, CalendarClock, Send, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import {
  userErrorMessage,
  type ClipAspectRatio,
  type ClipSnapshot,
  type SocialAccountSnapshot,
  type SocialPlatform,
  type SocialPostSnapshot,
} from "@narriflow/validators";
import { formatDateTime } from "@/lib/format";

const platformLabels: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  linkedin: "LinkedIn",
  x: "X",
};

const platforms = Object.keys(platformLabels) as SocialPlatform[];

const platformItems = platforms.map((value) => ({
  value,
  label: platformLabels[value],
}));

function firstRenderedAspectRatio(clip: ClipSnapshot): ClipAspectRatio | null {
  return clip.renderVariants.find((render) => render.hasAsset)?.aspectRatio ?? null;
}

function postStripe(status: SocialPostSnapshot["status"]): string {
  if (status === "posted") return "success.solid";
  if (status === "failed") return "danger.solid";
  if (status === "scheduled" || status === "publishing") return "accent.solid";
  return "border.emphasized";
}

function postLabelColor(status: SocialPostSnapshot["status"]): string {
  if (status === "posted") return "success.fg";
  if (status === "failed") return "danger.fg";
  if (status === "scheduled" || status === "publishing") return "accent.fg";
  return "fg.muted";
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
  const renderedClips = useMemo(
    () => clips.filter((clip) => firstRenderedAspectRatio(clip)),
    [clips],
  );
  const [clipId, setClipId] = useState(renderedClips[0]?.id ?? "");
  const selectedClip = renderedClips.find((clip) => clip.id === clipId) ?? null;
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
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedAccount =
    platformAccounts.find((account) => account.id === accountId) ?? null;

  const clipItems = useMemo(
    () =>
      renderedClips.length === 0
        ? [{ value: "", label: "No rendered clips", disabled: true }]
        : renderedClips.map((clip) => ({
            value: clip.id,
            label: `Clip ${clip.index + 1}`,
          })),
    [renderedClips],
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
      setMessage("Render a clip before scheduling it.");
      return;
    }
    if (!selectedAccount) {
      setMessage(`Connect a ${platformLabels[platform]} account before scheduling.`);
      return;
    }
    const aspectRatio = firstRenderedAspectRatio(selectedClip);
    if (!aspectRatio) {
      setMessage("Selected clip has no rendered asset.");
      return;
    }
    setMessage(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/social-posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clipId: selectedClip.id,
          accountId: selectedAccount.id,
          platform,
          caption,
          aspectRatio,
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        console.error("schedule_post_failed", response.status, payload);
        setMessage(
          payload?.message ??
            userErrorMessage(payload?.error) ??
            "Could not schedule post.",
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      console.error("schedule_post_failed", err);
      setMessage("Could not schedule post. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelPost(postId: string) {
    if (submitting) {
      return;
    }
    setMessage(null);
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
        setMessage(
          payload?.message ??
            userErrorMessage(payload?.error) ??
            "Could not cancel this post. Please try again.",
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      console.error("cancel_post_failed", err);
      setMessage("Could not cancel this post. Please try again.");
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
            Queue captions and rendered clips for platform publishing workflows.
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
                const nextClip = renderedClips.find((clip) => clip.id === nextId);
                if (nextClip) setCaption(nextClip.hookText);
              }}
              size="sm"
              placeholder="No rendered clips"
              disabled={renderedClips.length === 0}
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
            <Input
              size="sm"
              type="datetime-local"
              value={scheduledFor}
              onChange={(event) => setScheduledFor(event.target.value)}
            />
          </Box>

          <Box>
            <Button
              size="sm"
              w={{ base: "full", lg: "auto" }}
              disabled={
                isPending ||
                submitting ||
                renderedClips.length === 0 ||
                !caption.trim() ||
                !selectedAccount
              }
              onClick={schedulePost}
            >
              <CalendarClock size={14} />
              <Text ms="1.5">Schedule</Text>
            </Button>
          </Box>
        </Grid>

        {message ? (
          <Flex align="center" gap="1.5" color="danger.fg">
            <AlertTriangle size={13} aria-hidden />
            <Text fontSize="xs">{message}</Text>
          </Flex>
        ) : null}

        {platformAccounts.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">
            <Link href="/settings/social">
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

        {posts.length > 0 ? (
          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
            {posts.map((post) => (
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
                  bg={postStripe(post.status)}
                />
                <Box minW="0">
                  <Flex align="center" gap="2" wrap="wrap">
                    <Text fontSize="13px" fontWeight="500" color="fg" truncate>
                      {platformLabels[post.platform]}
                      {post.accountDisplayName ? ` · ${post.accountDisplayName}` : ""}
                    </Text>
                    <Text textStyle="eyebrow" color={postLabelColor(post.status)}>
                      {post.status}
                    </Text>
                  </Flex>
                  <Text fontSize="xs" color="fg.muted" truncate>
                    {post.scheduledFor ? (
                      <Text as="span" textStyle="data" fontSize="11px">
                        {formatDateTime(post.scheduledFor)}
                      </Text>
                    ) : (
                      "No scheduled time"
                    )}{" "}
                    · {post.caption}
                  </Text>
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
                        {post.externalUrl}
                      </Text>
                    </a>
                  ) : null}
                </Box>
                {post.status === "scheduled" ? (
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
            ))}
          </Stack>
        ) : (
          <EmptyState
            icon={<Send size={22} aria-hidden />}
            title="Nothing scheduled yet"
            description="Queue a rendered clip to a connected account — scheduled and published posts will be listed here."
            ratio={9 / 16}
          />
        )}
      </Stack>
    </Box>
  );
}
