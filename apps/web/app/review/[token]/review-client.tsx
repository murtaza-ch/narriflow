"use client";

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Film,
  Lock,
  MessageSquareText,
  Pencil,
  Reply,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Box, Flex, Heading, Stack, Text, Textarea, VisuallyHidden } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Logo } from "@narriflow/ui/components/logo";
import { Progress } from "@narriflow/ui/components/progress";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { formatTimecode } from "@/lib/format";
import { buildReviewCommentPayload, reviewApprovalProgress } from "./review-client-model";

type ReviewComment = {
  id: string;
  itemId: string | null;
  parentId: string | null;
  authorKind: string;
  authorName: string;
  body: string;
  timestampSec: number | null;
  resolvedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  canEdit: boolean;
};

type ReviewItem = {
  id: string;
  clipTitle: string;
  required: boolean;
  currentDecision: string | null;
  export: {
    variants: Array<{
      id: string;
      aspectRatio: string;
      durationSec: number | null;
      status: string;
    }>;
  };
};

type ReviewSnapshot = {
  id: string;
  title: string;
  message: string | null;
  projectTitle: string;
  agencyName: string;
  revision: number;
  status: string;
  allowDownloads: boolean;
  approvalRequired: boolean;
  reviewer: string;
  items: ReviewItem[];
  comments: ReviewComment[];
};

function aspectLabel(value: string) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

/** "9:16" as a width/height number; 16/9 when the label is not a ratio. */
function aspectNumber(label: string) {
  const [width, height] = label.split(":").map(Number);
  return width && height ? width / height : 16 / 9;
}

function initialsOf(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function decisionLabel(decision: string | null) {
  return decision === "approved" ? "Approved" : decision === "changes_requested" ? "Changes requested" : "Awaiting decision";
}

/** What a round that is no longer open (or already decided) says to the reviewer. */
function roundNotice(status: string): { tone: "accent" | "warning" | "neutral"; title: string; detail: string; icon: ReactNode } | null {
  switch (status) {
    case "open":
      return null;
    case "approved":
      return { tone: "accent", title: "Round approved", detail: "The team has your sign-off.", icon: <Check size={16} strokeWidth={2.5} /> };
    case "changes_requested":
      // Still open: the reviewer may be mid-way, and each clip shows its own decision.
      return null;
    case "superseded":
      return { tone: "neutral", title: "A newer round replaced this one", detail: "Ask the sender for the latest link.", icon: <Clock3 size={16} /> };
    case "expired":
      return { tone: "neutral", title: "This review has expired", detail: "Ask the sender for a new link.", icon: <Clock3 size={16} /> };
    default:
      return { tone: "neutral", title: "This review is closed", detail: "Ask the sender for a new link.", icon: <Ban size={16} /> };
  }
}

export function ReviewClient({ token }: { token: string }) {
  const endpoint = `/api/review/${encodeURIComponent(token)}`;
  const [identity, setIdentity] = useState("");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [round, setRound] = useState<ReviewSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [activeVariants, setActiveVariants] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [includeTimecode, setIncludeTimecode] = useState(true);
  const [commentScope, setCommentScope] = useState<"clip" | "round">("clip");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The server stops serving a round once it closes (expired, revoked,
  // replaced), so the client learns it from a refused action, not a status.
  const [closed, setClosed] = useState(false);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const accessErrorRef = useRef<HTMLDivElement>(null);

  const activeItem = round?.items.find((item) => item.id === activeItemId) ?? round?.items[0] ?? null;
  const activeVariant = activeItem?.export.variants.find((variant) =>
    variant.id === activeVariants[activeItem.id],
  ) ?? activeItem?.export.variants[0] ?? null;
  const approvalProgress = reviewApprovalProgress(round?.items ?? [], round?.approvalRequired ?? true);
  const requiredApproved = approvalProgress.approved;
  const requiredCount = approvalProgress.required;
  const roundReady = approvalProgress.ready;
  const commentsForActiveItem = useMemo(
    () => round?.comments.filter((entry) => entry.itemId === activeItem?.id || entry.itemId === null) ?? [],
    [activeItem?.id, round?.comments],
  );

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Review could not be loaded");
    setRound(payload.round);
    setActiveItemId((current) => current && payload.round.items.some((item: ReviewItem) => item.id === current) ? current : payload.round.items[0]?.id ?? null);
    setActiveVariants((current) => ({
      ...Object.fromEntries(payload.round.items.map((item: ReviewItem) => [item.id, item.export.variants[0]?.id ?? ""])),
      ...current,
    }));
  }, [endpoint]);

  useEffect(() => {
    void load().catch(() => undefined).finally(() => setChecking(false));
  }, [load]);

  useLayoutEffect(() => {
    if (!round && error) accessErrorRef.current?.focus();
  }, [error, round]);

  async function access(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity, email, passcode: passcode || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Access could not be verified");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Access could not be verified");
    } finally {
      setBusy(false);
    }
  }

  async function request(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${endpoint}/${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.error === "review_session_invalid" || payload.error === "review_round_closed") setClosed(true);
        throw new Error(payload.message || "Review response could not be saved");
      }
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review response could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveComment() {
    if (!comment.trim()) return;
    if (editingCommentId) {
      if (await request(`comments/${editingCommentId}`, "PATCH", { body: comment.trim() })) {
        setNotice("Comment updated.");
        setComment("");
        setEditingCommentId(null);
        commentRef.current?.focus();
      }
      return;
    }
    const parent = replyTo ? round?.comments.find((entry) => entry.id === replyTo) : null;
    const video = activeItem ? videoRefs.current.get(activeItem.id) : undefined;
    const payload = buildReviewCommentPayload({
      body: comment,
      activeItemId: activeItem?.id ?? null,
      parent: parent ? { id: parent.id, itemId: parent.itemId } : null,
      scope: commentScope,
      includeTimecode,
      currentTimeSec: video?.currentTime ?? null,
    });
    if (await request("comments", "POST", payload)) {
      const { timestampSec } = payload;
      setNotice(parent ? "Reply added." : timestampSec === null ? "Comment added." : `Comment added at ${formatTimecode(timestampSec)}.`);
      setComment("");
      setReplyTo(null);
      commentRef.current?.focus();
    }
  }

  async function decide(decision: "approved" | "changes_requested", itemId: string | null) {
    if (await request("decision", "POST", { decision, itemId, reason: null })) {
      setNotice(decision === "approved" ? "Approval saved." : "Change request saved.");
    }
  }

  function startEditing(entry: ReviewComment) {
    setEditingCommentId(entry.id);
    setReplyTo(null);
    setComment(entry.body);
    requestAnimationFrame(() => commentRef.current?.focus());
  }

  function startReply(entry: ReviewComment) {
    setReplyTo(entry.id);
    setEditingCommentId(null);
    setComment("");
    requestAnimationFrame(() => commentRef.current?.focus());
  }

  function seekTo(seconds: number) {
    const video = activeItem ? videoRefs.current.get(activeItem.id) : undefined;
    if (!video) return;
    video.currentTime = seconds;
    void video.play();
  }

  if (!round) {
    return (
      <Flex minH="100dvh" bg="bg.sidebar" direction="column" align="center" justify="center" gap="6" px="4" py="10">
        <Logo size="md" />
        {checking ? (
          <Spinner size="md" />
        ) : (
          <Stack as="form" onSubmit={access} w="full" maxW="440px" gap="6" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
            <Stack gap="2">
              <Heading as="h1" textStyle="title" fontSize="24px">
                Enter the review room
              </Heading>
              <Text fontSize="14px" color="fg.muted">
                Your name and email go with your comments and approvals. No Narriflow account needed.
              </Text>
            </Stack>
            <Stack gap="4">
              <Stack gap="1.5">
                <Label htmlFor="reviewer-name">Name</Label>
                <Input id="reviewer-name" size="md" h="11" autoComplete="name" value={identity} onChange={(event) => setIdentity(event.target.value)} required />
              </Stack>
              <Stack gap="1.5">
                <Label htmlFor="reviewer-email">Email</Label>
                <Input id="reviewer-email" size="md" h="11" autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </Stack>
              <Stack gap="1.5">
                <Label htmlFor="review-passcode">Passcode</Label>
                <Input
                  id="review-passcode"
                  size="md"
                  h="11"
                  autoComplete="one-time-code"
                  type="password"
                  value={passcode}
                  placeholder="Only if your sender gave you one"
                  onChange={(event) => setPasscode(event.target.value)}
                />
              </Stack>
            </Stack>
            {error ? (
              <Flex ref={accessErrorRef} tabIndex={-1} role="alert" align="flex-start" gap="2" px="4" py="3" bg="danger.subtle" color="danger.fg" borderRadius="l2" outline="none">
                <Box flexShrink={0} mt="0.5">
                  <AlertTriangle size={14} aria-hidden />
                </Box>
                <Text fontSize="13px">{error}</Text>
              </Flex>
            ) : null}
            <Button type="submit" size="md" h="11" w="full" disabled={!identity.trim() || !email.trim() || busy}>
              {busy ? "Checking access…" : "Open review"}
              {busy ? null : <ArrowRight size={16} />}
            </Button>
            <Flex align="center" justify="center" gap="1.5" color="fg.subtle">
              <Lock size={12} aria-hidden />
              <Text fontSize="12px">Private link. Nothing is shown until access is verified.</Text>
            </Flex>
          </Stack>
        )}
      </Flex>
    );
  }

  const status = roundNotice(closed ? "closed" : round.status);
  // A round that closed (expired, revoked or replaced) takes no more input.
  const frozen = closed || round.status === "expired" || round.status === "revoked" || round.status === "superseded";
  const roundOpen = !frozen && (round.status === "open" || round.status === "changes_requested");
  const topLevel = commentsForActiveItem.filter((entry) => entry.parentId === null);
  const progressPercent = requiredCount === 0 ? 100 : Math.round((requiredApproved / requiredCount) * 100);
  const panelRadius = { base: "0", md: "12px" } as const;

  return (
    <Flex direction="column" minH="100dvh" h={{ lg: "100dvh" }} bg="bg.sidebar" p={{ base: "0", md: "2" }} gap="2">
      <Flex as="header" h="56px" flexShrink={0} align="center" justify="space-between" gap="4" px={{ base: "4", md: "5" }} bg="bg" borderRadius={panelRadius}>
        <Flex align="center" gap="4" minW="0">
          <Box flexShrink={0}>
            <Logo size="sm" />
          </Box>
          <Box w="1px" h="5" bg="bg.muted" flexShrink={0} aria-hidden />
          <Box minW="0">
            <Heading as="h1" fontSize="15px" fontWeight="500" lineHeight="1.25" truncate>
              {round.projectTitle}
            </Heading>
            <Text fontSize="12px" color="fg.subtle" lineHeight="1.25" truncate>
              {round.agencyName} · Round {String(round.revision).padStart(2, "0")}
            </Text>
          </Box>
        </Flex>
        <Flex align="center" gap="2.5" flexShrink={0} title="Reviewing as">
          <Flex boxSize="7" align="center" justify="center" borderRadius="full" bg="bg.soft" fontSize="11px" fontWeight="500" aria-hidden>
            {initialsOf(round.reviewer)}
          </Flex>
          <Box display={{ base: "none", sm: "block" }}>
            <Text fontSize="13px" fontWeight="500" lineHeight="1.25">
              {round.reviewer}
            </Text>
            <Text fontSize="12px" color="fg.subtle" lineHeight="1.25">
              Reviewing
            </Text>
          </Box>
        </Flex>
      </Flex>

      <Flex flex="1" minH="0" gap="2" direction={{ base: "column", lg: "row" }}>
        {/* Stage: the clip, front and centre, with its decision underneath. */}
        <Flex flex="1" minW="0" minH={{ lg: "0" }} direction="column" gap="4" p={{ base: "4", md: "5" }} bg="bg" borderRadius={panelRadius}>
          {status ? (
            <Flex align="center" gap="3" px="4" py="3" bg={status.tone === "neutral" ? "bg.soft" : `${status.tone}.subtle`} borderRadius="l2">
              <Flex boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="full" bg={status.tone === "neutral" ? "bg.soft" : `${status.tone}.muted`} color={status.tone === "neutral" ? "fg.muted" : `${status.tone}.fg`} aria-hidden>
                {status.icon}
              </Flex>
              <Box>
                <Text fontSize="14px" fontWeight="500">
                  {status.title}
                </Text>
                <Text fontSize="13px" color="fg.muted">
                  {status.detail}
                </Text>
              </Box>
            </Flex>
          ) : null}
          {round.message ? (
            <Flex align="flex-start" gap="2.5" px="4" py="3" bg="bg.subtle" borderRadius="l2">
              <Box color="fg.subtle" mt="0.5" flexShrink={0}>
                <MessageSquareText size={15} aria-hidden />
              </Box>
              <Text fontSize="13px" color="fg.muted">
                {round.message}
              </Text>
            </Flex>
          ) : null}
          {notice ? (
            <Flex role="status" aria-live="polite" gap="2" align="center" color="success.fg">
              <CheckCircle2 size={14} aria-hidden />
              <Text fontSize="13px">{notice}</Text>
            </Flex>
          ) : null}
          {error ? (
            <Flex role="alert" gap="2" align="center" color="danger.fg">
              <AlertTriangle size={14} aria-hidden />
              <Text fontSize="13px">{error}</Text>
            </Flex>
          ) : null}

          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <Flex role="tablist" aria-label="Submitted clips" gap="1" overflowX="auto" flex="1" minW="0">
              {round.items.map((item, index) => {
                const selected = activeItem?.id === item.id;
                return (
                  <Button
                    key={item.id}
                    role="tab"
                    aria-selected={selected}
                    variant="ghost"
                    flexShrink="0"
                    position="relative"
                    color={selected ? "fg" : "fg.muted"}
                    _after={selected ? { content: '""', position: "absolute", insetInline: "3", bottom: "0", h: "2px", borderRadius: "full", bg: "accent.solid" } : undefined}
                    onClick={() => setActiveItemId(item.id)}
                  >
                    <Box
                      boxSize="1.5"
                      borderRadius="full"
                      bg={item.currentDecision === "approved" ? "accent.solid" : item.currentDecision === "changes_requested" ? "warning.solid" : "fg.disabled"}
                      aria-hidden
                    />
                    <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">
                      {String(index + 1).padStart(2, "0")}
                    </Text>
                    <Text maxW="200px" truncate>
                      {item.clipTitle}
                    </Text>
                    {item.required ? null : (
                      <Text as="span" fontSize="11px" color="fg.subtle" aria-hidden>
                        Optional
                      </Text>
                    )}
                    <VisuallyHidden>{`${item.required ? "Required" : "Optional"}, ${decisionLabel(item.currentDecision)}`}</VisuallyHidden>
                  </Button>
                );
              })}
            </Flex>
            {activeItem && activeItem.export.variants.length > 1 && activeVariant ? (
              <SegmentedControl
                aria-label="Format"
                value={activeVariant.id}
                onValueChange={(value) => setActiveVariants((current) => ({ ...current, [activeItem.id]: value }))}
                items={activeItem.export.variants.map((variant) => ({ value: variant.id, label: aspectLabel(variant.aspectRatio) }))}
              />
            ) : null}
          </Flex>

          {activeItem && activeVariant ? (
            <Flex role="tabpanel" aria-label={activeItem.clipTitle} flex="1" minH="0" direction="column" gap="4">
              <Flex flex="1" minH="0" justify="center">
                <Box
                  position="relative"
                  aspectRatio={aspectNumber(aspectLabel(activeVariant.aspectRatio))}
                  h={{ base: "auto", lg: "full" }}
                  w={{ base: "full", lg: "auto" }}
                  maxW={{ base: aspectNumber(aspectLabel(activeVariant.aspectRatio)) < 1 ? "360px" : "full", lg: "full" }}
                  borderRadius="l3"
                  overflow="hidden"
                  bg="studio.canvas"
                >
                  {/* biome-ignore lint/a11y/useMediaCaption: submitted exports contain the final burned-in captions. */}
                  <video
                    ref={(node) => {
                      if (node) videoRefs.current.set(activeItem.id, node);
                      else videoRefs.current.delete(activeItem.id);
                    }}
                    key={activeVariant.id}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={`${activeItem.clipTitle}, ${aspectLabel(activeVariant.aspectRatio)} submitted export`}
                    src={`${endpoint}/media/${activeItem.id}/${activeVariant.id}`}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                </Box>
              </Flex>
              <Flex justify="center" align="center" gap="2" wrap="wrap">
                <Button
                  size="md"
                  variant={activeItem.currentDecision === "approved" ? "subtle" : "solid"}
                  bg={activeItem.currentDecision === "approved" ? "accent.subtle" : undefined}
                  color={activeItem.currentDecision === "approved" ? "accent.fg" : undefined}
                  _hover={activeItem.currentDecision === "approved" ? { bg: "accent.muted" } : undefined}
                  disabled={busy || frozen}
                  onClick={() => void decide("approved", activeItem.id)}
                >
                  <Check size={16} /> {activeItem.currentDecision === "approved" ? "Approved" : "Approve clip"}
                </Button>
                <Button
                  size="md"
                  variant="subtle"
                  bg={activeItem.currentDecision === "changes_requested" ? "warning.subtle" : undefined}
                  color={activeItem.currentDecision === "changes_requested" ? "warning.fg" : undefined}
                  disabled={busy || frozen}
                  onClick={() => void decide("changes_requested", activeItem.id)}
                >
                  {activeItem.currentDecision === "changes_requested" ? "Changes requested" : "Request changes"}
                </Button>
                {round.allowDownloads ? (
                  <Button asChild size="md" variant="ghost">
                    <a href={`${endpoint}/download/${activeItem.id}/${activeVariant.id}`}>
                      <Download size={16} /> Download {aspectLabel(activeVariant.aspectRatio)}
                    </a>
                  </Button>
                ) : null}
              </Flex>
            </Flex>
          ) : (
            <Flex flex="1" direction="column" align="center" justify="center" gap="3" py="10" color="fg.muted">
              <Flex boxSize="11" align="center" justify="center" borderRadius="full" bg="bg.soft" aria-hidden>
                <AlertTriangle size={20} />
              </Flex>
              <Text fontSize="14px">Submitted media is unavailable.</Text>
            </Flex>
          )}
        </Flex>

        {/* Side panel: feedback on the clip, then the decision on the round. */}
        <Flex w={{ base: "full", lg: "380px" }} flexShrink={0} direction="column" gap="4" p={{ base: "4", md: "5" }} bg="bg" borderRadius={panelRadius} minH="0">
          <Flex align="center" justify="space-between" gap="3">
            <Text textStyle="eyebrow" color="fg.muted">
              Feedback
            </Text>
            {activeItem ? (
              <Text fontSize="12px" color="fg.subtle" truncate>
                {activeItem.clipTitle}
              </Text>
            ) : null}
          </Flex>

          <Stack flex="1" minH={{ base: "0", lg: "120px" }} gap="2" overflowY="auto" mx="-1" px="1">
            {topLevel.length === 0 ? (
              <Flex flex="1" direction="column" align="center" justify="center" gap="2.5" py="8" textAlign="center">
                <Flex boxSize="11" align="center" justify="center" borderRadius="full" bg="bg.soft" color="fg.muted" aria-hidden>
                  <MessageSquareText size={20} />
                </Flex>
                <Text fontSize="14px" fontWeight="500">
                  No comments yet
                </Text>
                <Text fontSize="13px" color="fg.muted" maxW="26ch">
                  Notes you add are pinned to the moment you are watching.
                </Text>
              </Flex>
            ) : (
              topLevel.map((thread) => {
                const replies = commentsForActiveItem.filter((entry) => entry.parentId === thread.id);
                return (
                  <Stack key={thread.id} gap="2.5" p="3.5" bg="bg.subtle" borderRadius="l2">
                    <Flex align="center" gap="2.5">
                      <Flex boxSize="6" flexShrink={0} align="center" justify="center" borderRadius="full" bg="bg.soft" fontSize="10px" fontWeight="500" aria-hidden>
                        {initialsOf(thread.authorName)}
                      </Flex>
                      <Text fontSize="13px" fontWeight="500" truncate>
                        {thread.authorName}
                      </Text>
                      <Text fontSize="12px" color="fg.subtle">
                        {thread.authorKind === "guest" ? "Reviewer" : "Team"}
                      </Text>
                      <Flex ms="auto" align="center" gap="2" flexShrink={0}>
                        {thread.timestampSec !== null ? (
                          <Button size="2xs" variant="ghost" bg="accent.subtle" color="accent.fg" _hover={{ bg: "accent.muted" }} onClick={() => seekTo(thread.timestampSec ?? 0)}>
                            <Text textStyle="data" fontSize="12px">
                              {formatTimecode(thread.timestampSec)}
                            </Text>
                          </Button>
                        ) : null}
                        {thread.resolvedAt ? (
                          <Box color="success.fg" display="flex" role="img" aria-label="Resolved">
                            <CheckCircle2 size={14} aria-hidden />
                          </Box>
                        ) : null}
                      </Flex>
                    </Flex>
                    <Text fontSize="13px" color="fg" whiteSpace="pre-wrap" overflowWrap="anywhere">
                      {thread.body}
                    </Text>
                    {thread.editedAt ? (
                      <Text fontSize="12px" color="fg.subtle">
                        Edited
                      </Text>
                    ) : null}
                    {replies.map((entry) => (
                      <Stack key={entry.id} gap="1" ms="8" px="3" py="2.5" bg="bg.soft" borderRadius="l1">
                        <Flex align="baseline" gap="2">
                          <Text fontSize="12px" fontWeight="500">
                            {entry.authorName}
                          </Text>
                          <Text fontSize="12px" color="fg.subtle">
                            {entry.authorKind === "guest" ? "Reviewer" : "Team"}
                          </Text>
                        </Flex>
                        <Text fontSize="13px" color="fg" whiteSpace="pre-wrap" overflowWrap="anywhere">
                          {entry.body}
                        </Text>
                        {entry.canEdit ? (
                          <Flex gap="1" ms="-2">
                            <Button size="2xs" variant="ghost" onClick={() => startEditing(entry)}>
                              <Pencil size={11} /> Edit
                            </Button>
                            <Button
                              size="2xs"
                              variant="ghost"
                              colorPalette="danger"
                              disabled={busy}
                              onClick={() => void request(`comments/${entry.id}`, "DELETE").then((saved) => { if (saved) setNotice("Reply deleted."); })}
                            >
                              <Trash2 size={11} /> Delete
                            </Button>
                          </Flex>
                        ) : null}
                      </Stack>
                    ))}
                    <Flex gap="1" ms="-2">
                      <Button size="2xs" variant="ghost" onClick={() => startReply(thread)}>
                        <Reply size={11} /> Reply
                      </Button>
                      {thread.canEdit ? (
                        <>
                          <Button size="2xs" variant="ghost" onClick={() => startEditing(thread)}>
                            <Pencil size={11} /> Edit
                          </Button>
                          <Button
                            size="2xs"
                            variant="ghost"
                            colorPalette="danger"
                            disabled={replies.length > 0 || busy}
                            onClick={() => void request(`comments/${thread.id}`, "DELETE").then((saved) => { if (saved) setNotice("Comment deleted."); })}
                          >
                            <Trash2 size={11} /> Delete
                          </Button>
                        </>
                      ) : null}
                    </Flex>
                  </Stack>
                );
              })
            )}
          </Stack>

          <Stack gap="2">
            {replyTo ? (
              <Flex align="center" justify="space-between" gap="2" ps="3" pe="1" py="1" bg="bg.soft" borderRadius="l2">
                <Flex align="center" gap="1.5" color="fg.muted">
                  <Reply size={12} aria-hidden />
                  <Text fontSize="12px">Replying in thread</Text>
                </Flex>
                <Button size="2xs" variant="ghost" aria-label="Cancel reply" onClick={() => { setReplyTo(null); setComment(""); }}>
                  <X size={12} />
                </Button>
              </Flex>
            ) : null}
            {editingCommentId ? (
              <Flex align="center" justify="space-between" gap="2" ps="3" pe="1" py="1" bg="bg.soft" borderRadius="l2">
                <Flex align="center" gap="1.5" color="fg.muted">
                  <Pencil size={12} aria-hidden />
                  <Text fontSize="12px">Editing your comment</Text>
                </Flex>
                <Button size="2xs" variant="ghost" aria-label="Cancel editing" onClick={() => { setEditingCommentId(null); setComment(""); }}>
                  <X size={12} />
                </Button>
              </Flex>
            ) : null}
            <Textarea
              ref={commentRef}
              rows={3}
              resize="none"
              value={comment}
              maxLength={2000}
              disabled={frozen}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Describe what should change, or why this works"
              aria-label="Review comment"
            />
            <Flex justify="space-between" align="center" gap="2" wrap="wrap">
              <Flex gap="1">
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={Boolean(replyTo || editingCommentId)}
                  onClick={() => setCommentScope((current) => (current === "clip" ? "round" : "clip"))}
                  bg={commentScope === "round" ? "accent.subtle" : undefined}
                  color={commentScope === "round" ? "accent.fg" : "fg.muted"}
                >
                  {commentScope === "round" ? <MessageSquareText size={12} /> : <Film size={12} />}
                  {commentScope === "round" ? "General feedback" : "Clip feedback"}
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={Boolean(replyTo || editingCommentId || !activeItem || commentScope === "round")}
                  aria-pressed={includeTimecode && commentScope === "clip"}
                  onClick={() => setIncludeTimecode((current) => !current)}
                  bg={includeTimecode && commentScope === "clip" ? "accent.subtle" : undefined}
                  color={includeTimecode && commentScope === "clip" ? "accent.fg" : "fg.muted"}
                >
                  <Clock3 size={12} /> Attach playhead
                </Button>
              </Flex>
              <Button size="sm" ms="auto" disabled={!comment.trim() || busy || frozen} onClick={() => void saveComment()}>
                <Send size={13} /> {editingCommentId ? "Save" : replyTo ? "Reply" : "Comment"}
              </Button>
            </Flex>
          </Stack>

          <Stack gap="3" p="4" bg="bg.subtle" borderRadius="l2">
            <Flex align="baseline" justify="space-between" gap="3">
              <Text textStyle="eyebrow" color="fg.muted">
                Round decision
              </Text>
              {requiredCount > 0 ? (
                <Text fontSize="12px" color={roundReady ? "accent.fg" : "fg.muted"} fontVariantNumeric="tabular-nums">
                  {requiredApproved} of {requiredCount} approved
                </Text>
              ) : null}
            </Flex>
            {requiredCount > 0 ? (
              <Progress value={progressPercent} label="Required approvals" />
            ) : null}
            {roundOpen ? (
              <Stack gap="2">
                <Text fontSize="13px" color="fg.muted">
                  {roundReady
                    ? "Every required clip is approved. You can approve the full submission."
                    : `${requiredCount - requiredApproved} required clip${requiredCount - requiredApproved === 1 ? " still needs" : "s still need"} approval.`}
                </Text>
                <Button w="full" disabled={busy || !roundReady} onClick={() => void decide("approved", null)}>
                  <Check size={15} /> Approve round
                </Button>
                <Button w="full" variant="subtle" disabled={busy} onClick={() => void decide("changes_requested", null)}>
                  Request changes on round
                </Button>
              </Stack>
            ) : (
              <Text fontSize="13px" color="fg.muted">
                This round is {round.status.replaceAll("_", " ")}.
              </Text>
            )}
          </Stack>
        </Flex>
      </Flex>
    </Flex>
  );
}
