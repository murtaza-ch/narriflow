"use client";

import {
  Box,
  Flex,
  Heading,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Progress } from "@narriflow/ui/components/progress";
import {
  Check,
  Download,
  MessageSquareText,
  Pencil,
  Reply,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatTimecode } from "@/lib/format";

type ReviewVariant = {
  id: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number | null;
  status: string;
};

type ReviewItem = {
  id: string;
  title: string;
  position: number;
  required: boolean;
  currentDecision: string | null;
  export: {
    id: string;
    editorRevision: number;
    variants: ReviewVariant[];
  };
};

type ReviewComment = {
  id: string;
  itemId: string | null;
  parentId: string | null;
  authorName: string;
  authorKind: string;
  body: string;
  timestampSec: number | null;
  resolvedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  isOwn: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

type ReviewSnapshot = {
  id: string;
  projectTitle: string;
  workspaceName: string;
  title: string;
  message: string | null;
  revision: number;
  status: string;
  responsesOpen: boolean;
  sentAt: string;
  expiresAt: string | null;
  allowDownloads: boolean;
  approvalRequired: boolean;
  campaignDecision: string | null;
  reviewer: string;
  progress: { approved: number; changesRequested: number; required: number };
  items: ReviewItem[];
  comments: ReviewComment[];
};

function ratioLabel(value: string) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function ReviewClient({ token }: { token: string }) {
  const endpoint = `/api/review/${encodeURIComponent(token)}`;
  const [identity, setIdentity] = useState("");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [round, setRound] = useState<ReviewSnapshot | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeItemId, setActiveItemId] = useState("");
  const [activeVariantId, setActiveVariantId] = useState("");
  const [comment, setComment] = useState("");
  const [roundNote, setRoundNote] = useState(false);
  const [capturedTime, setCapturedTime] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<ReviewComment | null>(null);
  const [editing, setEditing] = useState<ReviewComment | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as {
      round?: ReviewSnapshot;
      message?: string;
    };
    if (!response.ok || !payload.round) {
      throw new Error(payload.message || "Review could not be loaded");
    }
    setRound(payload.round);
    setActiveItemId((current) => current || payload.round!.items[0]?.id || "");
  }, [endpoint]);

  useEffect(() => {
    let active = true;
    void load()
      .catch(() => undefined)
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const activeItem =
    round?.items.find((item) => item.id === activeItemId) ??
    round?.items[0] ??
    null;
  const activeVariant =
    activeItem?.export.variants.find(
      (variant) => variant.id === activeVariantId,
    ) ?? activeItem?.export.variants[0] ?? null;

  const activeItemIdForReset = activeItem?.id ?? "";
  const firstVariantId = activeItem?.export.variants[0]?.id ?? "";

  useEffect(() => {
    setActiveVariantId(activeItemIdForReset ? firstVariantId : "");
    setCapturedTime(null);
    setReplyTo(null);
    setEditing(null);
  }, [activeItemIdForReset, firstVariantId]);

  const visibleComments = useMemo(() => {
    if (!round) return [];
    return round.comments.filter(
      (entry) => entry.itemId === null || entry.itemId === activeItem?.id,
    );
  }, [activeItem?.id, round]);

  const mutate = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${path}`, {
        method,
        headers:
          body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.message || "Your review response could not be saved",
        );
      }
      await load();
      requestAnimationFrame(() => statusRef.current?.focus());
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Your review response could not be saved",
      );
      requestAnimationFrame(() => statusRef.current?.focus());
      return false;
    } finally {
      setBusy(false);
    }
  };

  const access = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity,
          email,
          passcode: passcode || null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message || "Access could not be verified");
      }
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Access could not be verified",
      );
      requestAnimationFrame(() => statusRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    const targetItemId = roundNote ? null : activeItem?.id ?? null;
    const saved = editing
      ? await mutate("PATCH", `comments/${editing.id}`, { body: comment })
      : await mutate("POST", "comments", {
          itemId: replyTo?.itemId ?? targetItemId,
          parentId: replyTo?.id ?? null,
          body: comment,
          timestampSec: replyTo ? null : capturedTime,
        });
    if (saved) {
      setComment("");
      setCapturedTime(null);
      setReplyTo(null);
      setEditing(null);
    }
  };

  if (checkingSession && !round) {
    return (
      <Flex minH="100dvh" bg="bg.canvas" align="center" justify="center">
        <Text textStyle="eyebrow" color="fg.muted">
          Opening private review…
        </Text>
      </Flex>
    );
  }

  if (!round) {
    return (
      <Flex minH="100dvh" bg="bg.canvas" align="center" justify="center" px="5">
        <Stack
          as="form"
          onSubmit={access}
          w="full"
          maxW="440px"
          gap="6"
          borderTopWidth="3px"
          borderColor="accent.solid"
          pt="6"
        >
          <Flex align="center" gap="3" color="accent.fg">
            <ShieldCheck size={22} aria-hidden />
            <Text textStyle="eyebrow">Private client review</Text>
          </Flex>
          <Box>
            <Heading
              textStyle="display"
              fontSize={{ base: "34px", md: "44px" }}
            >
              Enter the review room
            </Heading>
            <Text mt="2" color="fg.muted">
              Identify yourself so feedback and decisions remain accountable.
            </Text>
          </Box>
          <Stack gap="3">
            <Input
              aria-label="Your name"
              autoComplete="name"
              placeholder="Your name"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              required
            />
            <Input
              aria-label="Email"
              autoComplete="email"
              placeholder="you@company.com"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <Input
              aria-label="Passcode"
              autoComplete="current-password"
              placeholder="Passcode, if required"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
            />
          </Stack>
          {error ? (
            <Text
              as="div"
              ref={statusRef}
              tabIndex={-1}
              role="alert"
              color="danger.fg"
              fontSize="13px"
            >
              {error}
            </Text>
          ) : null}
          <Button
            type="submit"
            disabled={!identity.trim() || !email.trim() || busy}
          >
            {busy ? "Checking…" : "Open review"}
          </Button>
        </Stack>
      </Flex>
    );
  }

  const isOpen = round.responsesOpen;
  const progressPercent = round.progress.required
    ? (round.progress.approved / round.progress.required) * 100
    : 100;
  const roots = visibleComments.filter((entry) => entry.parentId === null);

  return (
    <Box minH="100dvh" bg="bg.canvas">
      <Box
        as="header"
        borderBottomWidth="1px"
        borderColor="border.subtle"
        px={{ base: "5", md: "8" }}
        py="5"
      >
        <Flex
          maxW="1280px"
          mx="auto"
          justify="space-between"
          align={{ base: "start", md: "end" }}
          gap="4"
          direction={{ base: "column", md: "row" }}
        >
          <Box>
            <Text textStyle="eyebrow" color="accent.fg">
              {round.workspaceName} · round {round.revision}
            </Text>
            <Heading textStyle="title" mt="1">
              {round.projectTitle}
            </Heading>
            <Text mt="1" fontSize="13px" color="fg.muted">
              {round.title}
            </Text>
          </Box>
          <Stack gap="1" align={{ base: "start", md: "end" }}>
            <Text fontSize="12px" color="fg.muted">
              Reviewing as {round.reviewer}
            </Text>
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              Sent {formatDate(round.sentAt)}
              {round.expiresAt
                ? ` · expires ${formatDate(round.expiresAt)}`
                : ""}
            </Text>
          </Stack>
        </Flex>
      </Box>

      <Box maxW="1280px" mx="auto" px={{ base: "5", md: "8" }} pt="5">
        <Flex align="center" gap="3">
          <Text textStyle="eyebrow" minW="fit-content">
            {round.progress.approved}/{round.progress.required} required clips
            approved
          </Text>
          <Box flex="1">
            <Progress value={progressPercent} />
          </Box>
          <Text
            textStyle="eyebrow"
            color={round.status === "open" ? "accent.fg" : "fg.muted"}
          >
            {statusLabel(round.status)}
          </Text>
        </Flex>
      </Box>

      <Flex
        maxW="1280px"
        mx="auto"
        p={{ base: "5", md: "8" }}
        gap="8"
        align="start"
        direction={{ base: "column", xl: "row" }}
      >
        <Stack flex="1" minW="0" gap="5" w="full">
          {round.message ? (
            <Box
              borderInlineStartWidth="3px"
              borderColor="accent.solid"
              ps="4"
              py="1"
            >
              <Text color="fg.muted">{round.message}</Text>
            </Box>
          ) : null}

          <Flex gap="2" overflowX="auto" pb="1" aria-label="Review clips">
            {round.items.map((item, index) => (
              <Button
                key={item.id}
                size="sm"
                variant={item.id === activeItem?.id ? "outline" : "ghost"}
                onClick={() => setActiveItemId(item.id)}
                aria-pressed={item.id === activeItem?.id}
              >
                {item.currentDecision === "approved" ? (
                  <Check size={13} aria-hidden />
                ) : null}
                {index + 1}. {item.title}
              </Button>
            ))}
          </Flex>

          {activeItem ? (
            <Stack gap="3">
              <Flex justify="space-between" align="end" gap="4">
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Clip {activeItem.position + 1}
                  </Text>
                  <Heading textStyle="title" fontSize="20px">
                    {activeItem.title}
                  </Heading>
                </Box>
                <Text textStyle="data" color="fg.timecode" fontSize="12px">
                  {activeVariant
                    ? `${ratioLabel(activeVariant.aspectRatio)} · ${activeVariant.resolution}`
                    : "No output"}
                </Text>
              </Flex>

              {activeVariant ? (
                <MediaWell ratio={16 / 9}>
                  {/* biome-ignore lint/a11y/useMediaCaption: reviewed media is the final export with captions burned in. */}
                  <video
                    ref={videoRef}
                    aria-label={`Review video: ${activeItem.title}, ${ratioLabel(activeVariant.aspectRatio)} ${activeVariant.resolution}. Captions are burned into the submitted export.`}
                    aria-keyshortcuts="Space K ArrowLeft ArrowRight"
                    controls
                    onKeyDown={(event) => {
                      const video = event.currentTarget;
                      if (event.key === " " || event.key.toLowerCase() === "k") {
                        event.preventDefault();
                        if (video.paused) {
                          void video.play().catch(() => undefined);
                        } else {
                          video.pause();
                        }
                      } else if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        video.currentTime = Math.max(0, video.currentTime - 5);
                      } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        video.currentTime = Math.min(
                          Number.isFinite(video.duration)
                            ? video.duration
                            : video.currentTime + 5,
                          video.currentTime + 5,
                        );
                      }
                    }}
                    playsInline
                    preload="metadata"
                    src={`${endpoint}/media/${activeItem.id}/${activeVariant.id}`}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                    }}
                    tabIndex={0}
                  />
                </MediaWell>
              ) : (
                <MediaWell>
                  <Flex h="full" align="center" justify="center">
                    <Text color="fg.muted">Media is still preparing.</Text>
                  </Flex>
                </MediaWell>
              )}

              {activeItem.export.variants.length > 1 ? (
                <Flex gap="2" wrap="wrap">
                  {activeItem.export.variants.map((variant) => (
                    <Button
                      key={variant.id}
                      size="xs"
                      variant={
                        variant.id === activeVariant?.id ? "outline" : "ghost"
                      }
                      onClick={() => setActiveVariantId(variant.id)}
                      aria-pressed={variant.id === activeVariant?.id}
                    >
                      {ratioLabel(variant.aspectRatio)} · {variant.resolution}
                    </Button>
                  ))}
                </Flex>
              ) : null}

              <Flex
                gap="2"
                wrap="wrap"
                borderTopWidth="1px"
                borderColor="border.subtle"
                pt="3"
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isOpen || busy}
                  onClick={() =>
                    void mutate("POST", "decision", {
                      decision: "approved",
                      itemId: activeItem.id,
                      reason: null,
                    })
                  }
                >
                  <Check size={14} aria-hidden /> Approve clip
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isOpen || busy}
                  onClick={() =>
                    void mutate("POST", "decision", {
                      decision: "changes_requested",
                      itemId: activeItem.id,
                      reason: decisionReason.trim() || null,
                    })
                  }
                >
                  Request changes
                </Button>
                {round.allowDownloads && activeVariant ? (
                  <Button asChild size="sm" variant="ghost">
                    <a
                      href={`${endpoint}/download/${activeItem.id}/${activeVariant.id}`}
                    >
                      <Download size={14} aria-hidden /> Download
                    </a>
                  </Button>
                ) : null}
              </Flex>
            </Stack>
          ) : null}
        </Stack>

        <Stack w={{ base: "full", xl: "380px" }} flexShrink="0" gap="5">
          <Box borderTopWidth="3px" borderColor="accent.solid" pt="4">
            <Flex gap="2" align="center">
              <MessageSquareText size={17} aria-hidden />
              <Text textStyle="eyebrow">Feedback</Text>
            </Flex>
            {replyTo ? (
              <Text mt="2" fontSize="12px" color="fg.muted">
                Replying to {replyTo.authorName}.{" "}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setReplyTo(null)}
                >
                  Cancel
                </Button>
              </Text>
            ) : editing ? (
              <Text mt="2" fontSize="12px" color="fg.muted">
                Editing your comment
              </Text>
            ) : null}
            <Textarea
              mt="3"
              rows={4}
              value={comment}
              onChange={(event) =>
                setComment(event.target.value.slice(0, 2000))
              }
              placeholder="Leave a clear, actionable note"
              aria-label="Review comment"
              disabled={!isOpen}
            />
            {capturedTime !== null ? (
              <Text
                mt="1"
                textStyle="data"
                fontSize="11px"
                color="fg.timecode"
              >
                Attached at {formatTimecode(capturedTime)}
              </Text>
            ) : null}
            <Flex mt="2" gap="2" wrap="wrap">
              <Button
                size="sm"
                variant="outline"
                disabled={!comment.trim() || busy || !isOpen}
                onClick={() => void submitComment()}
              >
                {editing
                  ? "Save edit"
                  : replyTo
                    ? "Post reply"
                    : "Add comment"}
              </Button>
              {!replyTo && !editing && activeVariant ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRoundNote(false);
                    setCapturedTime(videoRef.current?.currentTime ?? 0);
                  }}
                >
                  Add current time
                </Button>
              ) : null}
              {!replyTo && !editing ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRoundNote((current) => !current);
                    setCapturedTime(null);
                  }}
                >
                  {roundNote ? "Attach to clip" : "Make this a round note"}
                </Button>
              ) : null}
            </Flex>
          </Box>

          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
            {roots.length === 0 ? (
              <Text py="4" fontSize="13px" color="fg.muted">
                No feedback yet.
              </Text>
            ) : (
              roots.map((entry) => {
                const thread = [
                  entry,
                  ...visibleComments.filter(
                    (commentEntry) => commentEntry.parentId === entry.id,
                  ),
                ];
                return (
                  <Stack key={entry.id} gap="0">
                    {thread.map((commentEntry, index) => (
                      <Box
                        key={commentEntry.id}
                        py="3"
                        ps={index > 0 ? "5" : "0"}
                        borderBottomWidth="1px"
                        borderColor="border.subtle"
                        opacity={commentEntry.resolvedAt ? 0.62 : 1}
                      >
                        <Flex
                          justify="space-between"
                          gap="3"
                          align="start"
                        >
                          <Box>
                            <Text fontSize="11px" fontWeight="700">
                              {commentEntry.authorName}
                              {commentEntry.authorKind === "internal"
                                ? " · Narriflow"
                                : ""}
                            </Text>
                            <Text
                              textStyle="data"
                              fontSize="10px"
                              color="fg.subtle"
                            >
                              {formatDate(commentEntry.createdAt)}
                              {commentEntry.editedAt ? " · edited" : ""}
                            </Text>
                          </Box>
                          {commentEntry.timestampSec !== null ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                if (commentEntry.itemId) {
                                  setActiveItemId(commentEntry.itemId);
                                }
                                requestAnimationFrame(() => {
                                  if (videoRef.current) {
                                    videoRef.current.currentTime =
                                      commentEntry.timestampSec ?? 0;
                                    void videoRef.current.play();
                                  }
                                });
                              }}
                            >
                              {formatTimecode(commentEntry.timestampSec)}
                            </Button>
                          ) : null}
                        </Flex>
                        <Text
                          mt="1.5"
                          fontSize="13px"
                          color="fg.muted"
                          whiteSpace="pre-wrap"
                        >
                          {commentEntry.body}
                        </Text>
                        <Flex mt="2" gap="1">
                          {index === 0 && isOpen ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setReplyTo(commentEntry);
                                setEditing(null);
                                setComment("");
                              }}
                            >
                              <Reply size={12} aria-hidden /> Reply
                            </Button>
                          ) : null}
                          {commentEntry.canEdit ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setEditing(commentEntry);
                                setReplyTo(null);
                                setComment(commentEntry.body);
                              }}
                            >
                              <Pencil size={12} aria-hidden /> Edit
                            </Button>
                          ) : null}
                          {commentEntry.canDelete ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              color="danger.fg"
                              onClick={() => {
                                if (window.confirm("Delete this comment?")) {
                                  void mutate(
                                    "DELETE",
                                    `comments/${commentEntry.id}`,
                                  );
                                }
                              }}
                            >
                              <Trash2 size={12} aria-hidden /> Delete
                            </Button>
                          ) : null}
                        </Flex>
                      </Box>
                    ))}
                  </Stack>
                );
              })
            )}
          </Stack>

          {isOpen ? (
            <Stack
              gap="2"
              borderTopWidth="1px"
              borderColor="border.subtle"
              pt="4"
            >
              <Textarea
                rows={2}
                value={decisionReason}
                onChange={(event) =>
                  setDecisionReason(event.target.value.slice(0, 1000))
                }
                placeholder="Optional decision note"
                aria-label="Decision note"
              />
              <Button
                disabled={
                  busy ||
                  (round.approvalRequired &&
                    round.items.some(
                      (item) => item.required && item.currentDecision !== "approved",
                    ))
                }
                onClick={() =>
                  void mutate("POST", "decision", {
                    decision: "approved",
                    itemId: null,
                    reason: decisionReason.trim() || null,
                  })
                }
              >
                <Check size={15} aria-hidden /> Approve round
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void mutate("POST", "decision", {
                    decision: "changes_requested",
                    itemId: null,
                    reason: decisionReason.trim() || null,
                  })
                }
              >
                Request changes to round
              </Button>
            </Stack>
          ) : (
            <Text fontSize="13px" color="fg.muted">
              This round is {statusLabel(round.status)}. Its media and history
              remain visible, but responses are closed.
            </Text>
          )}

          <Box ref={statusRef} tabIndex={-1} aria-live="polite">
            {error ? (
              <Text role="alert" color="danger.fg" fontSize="13px">
                {error}
              </Text>
            ) : null}
          </Box>
        </Stack>
      </Flex>
    </Box>
  );
}
