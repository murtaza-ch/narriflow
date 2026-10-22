"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Film,
  MessageSquareText,
  Pencil,
  Reply,
  Send,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Box, chakra, Flex, Heading, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
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

export function ReviewClient({ token }: { token: string }) {
  const endpoint = `/api/review/${encodeURIComponent(token)}`;
  const [identity, setIdentity] = useState("");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [round, setRound] = useState<ReviewSnapshot | null>(null);
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
    void load().catch(() => undefined);
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
      if (!response.ok) throw new Error(payload.message || "Review response could not be saved");
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

  if (!round) {
    return (
      <Flex minH="100dvh" bg="bg" align="center" justify="center" px="5" py="10" layerStyle="blueprint">
        <Box w="full" maxW="460px" bg="bg.panel" borderWidth="1px" borderColor="border.card" borderRadius="l3" overflow="hidden">
                  <Stack as="form" onSubmit={access} gap="6" p={{ base: "6", md: "8" }}>
            
            <Box><Heading as="h1" textStyle="display" fontSize={{ base: "32px", md: "42px" }} lineHeight="1.05">Enter the review room</Heading><Text mt="3" color="fg.muted" fontSize="sm">Your name and email attach accountability to comments and approvals. No Narriflow account is required.</Text></Box>
            <Stack gap="4">
              <Stack gap="1.5"><chakra.label htmlFor="reviewer-name" fontSize="12px" fontWeight="650">Name</chakra.label><Input id="reviewer-name" autoComplete="name" value={identity} onChange={(event) => setIdentity(event.target.value)}  required /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="reviewer-email" fontSize="12px" fontWeight="650">Email</chakra.label><Input id="reviewer-email" autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)}  required /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="review-passcode" fontSize="12px" fontWeight="650">Passcode</chakra.label><Input id="review-passcode" autoComplete="one-time-code" type="password" value={passcode} placeholder="Only if your sender provided one" onChange={(event) => setPasscode(event.target.value)} /></Stack>
            </Stack>
            {error ? <Flex ref={accessErrorRef} tabIndex={-1} role="alert" align="start" gap="2" color="danger.fg" outline="none"><AlertTriangle size={14} aria-hidden /><Text fontSize="13px">{error}</Text></Flex> : null}
            <Button type="submit" colorPalette="brand" disabled={!identity.trim() || !email.trim() || busy}>{busy ? "Checking access…" : "Open review"}</Button>
            <Text fontSize="12px" color="fg.subtle" textAlign="center">This link is private. Narriflow does not expose project details until access is verified.</Text>
          </Stack>
        </Box>
      </Flex>
    );
  }

  return (
    <Box minH="100dvh" bg="bg">
      <Box as="header" bg="bg.panel" px={{ base: "4", md: "8" }} py="4">
        <Flex maxW="1320px" mx="auto" justify="space-between" align={{ base: "start", md: "end" }} gap="4" direction={{ base: "column", md: "row" }}>
          <Box><Flex align="center" gap="2"><Text textStyle="eyebrow" color="fg.muted">{round.agencyName} · Round {String(round.revision).padStart(2, "0")}</Text></Flex><Heading as="h1" textStyle="title" fontSize={{ base: "20px", md: "24px" }} mt="1">{round.projectTitle}</Heading></Box>
          <Flex gap="6" align="end"><Box textAlign={{ base: "start", md: "end" }}><Text fontSize="12px" color="fg.subtle">Reviewing as</Text><Text fontSize="13px" fontWeight="500">{round.reviewer}</Text></Box><Box textAlign={{ base: "start", md: "end" }}><Text fontSize="12px" color="fg.subtle">Required approvals</Text><Text fontSize="13px" fontWeight="500" fontVariantNumeric="tabular-nums" color={roundReady ? "success.fg" : "fg"}>{requiredApproved}/{requiredCount}</Text></Box></Flex>
        </Flex>
      </Box>

      <Box maxW="1320px" mx="auto" px={{ base: "4", md: "8" }} py={{ base: "5", md: "8" }}>
        {round.message ? <Box bg="bg.soft" borderRadius="l2" px="4" py="3" mb="6"><Text fontSize="sm" color="fg.muted">{round.message}</Text></Box> : null}
        {notice ? <Flex role="status" aria-live="polite" gap="2" align="center" color="success.fg" mb="4"><CheckCircle2 size={14} /><Text fontSize="13px">{notice}</Text></Flex> : null}
        {error ? <Flex role="alert" gap="2" align="center" color="danger.fg" mb="4"><AlertTriangle size={14} /><Text fontSize="13px">{error}</Text></Flex> : null}

        <Flex gap="7" align="start" direction={{ base: "column", lg: "row" }}>
          <Stack flex="1" w="full" minW="0" gap="5">
            <Flex gap="0" overflowX="auto" borderBottomWidth="1px" borderColor="border.subtle" role="tablist" aria-label="Submitted clips">
              {round.items.map((item, index) => <Button key={item.id} role="tab" aria-selected={activeItem?.id === item.id} variant="ghost" borderRadius="0" borderBottomWidth="2px" borderColor={activeItem?.id === item.id ? "accent.solid" : "transparent"} color={activeItem?.id === item.id ? "fg" : "fg.muted"} flexShrink="0" onClick={() => setActiveItemId(item.id)}><Text fontSize="12px" fontVariantNumeric="tabular-nums">{String(index + 1).padStart(2, "0")}</Text><Text ms="2" maxW="180px" truncate>{item.clipTitle}</Text></Button>)}
            </Flex>

            {activeItem && activeVariant ? (
              <Box role="tabpanel" aria-label={activeItem.clipTitle} layerStyle="well" overflow="hidden" borderRadius="l2">
                <Flex px="4" py="3" justify="space-between" align="center" gap="3"><Text fontSize="13px" color="fg">{activeItem.clipTitle}</Text><Flex gap="2" wrap="wrap" justify="end">{activeItem.export.variants.map((variant) => <Button key={variant.id} size="xs" variant="subtle" borderWidth="2px" borderColor={variant.id === activeVariant.id ? "accent.solid" : "transparent"} bg={variant.id === activeVariant.id ? "accent.subtle" : undefined} color="fg" onClick={() => setActiveVariants((current) => ({ ...current, [activeItem.id]: variant.id }))}>{aspectLabel(variant.aspectRatio)}</Button>)}</Flex></Flex>
                <Box bg="studio.canvas" display="flex" justifyContent="center">
                  {/* biome-ignore lint/a11y/useMediaCaption: submitted exports contain the final burned-in captions. */}
                  <video ref={(node) => { if (node) videoRefs.current.set(activeItem.id, node); else videoRefs.current.delete(activeItem.id); }} key={activeVariant.id} controls playsInline preload="metadata" aria-label={`${activeItem.clipTitle}, ${aspectLabel(activeVariant.aspectRatio)} submitted export`} src={`${endpoint}/media/${activeItem.id}/${activeVariant.id}`} style={{ width: "100%", maxHeight: "68vh", objectFit: "contain" }} />
                </Box>
                <Flex px="4" py="3" align={{ base: "stretch", sm: "center" }} direction={{ base: "column", sm: "row" }} justify="space-between" gap="3"><Flex gap="2"><Button size="sm" variant="subtle" bg={activeItem.currentDecision === "approved" ? "accent.subtle" : undefined} color={activeItem.currentDecision === "approved" ? "accent.fg" : undefined} _hover={activeItem.currentDecision === "approved" ? { bg: "accent.muted" } : undefined} disabled={busy} onClick={() => void decide("approved", activeItem.id)}><Check size={14} /> Approve clip</Button><Button size="sm" variant="subtle" disabled={busy} onClick={() => void decide("changes_requested", activeItem.id)}>Request changes</Button></Flex>{round.allowDownloads ? <Button asChild size="sm" variant="ghost"><a href={`${endpoint}/download/${activeItem.id}/${activeVariant.id}`}><Download size={14} /> Download {aspectLabel(activeVariant.aspectRatio)}</a></Button> : null}</Flex>
              </Box>
            ) : <Box layerStyle="well" p="10"><Text color="fg.muted">Submitted media is unavailable.</Text></Box>}

            <Stack gap="0">
                          {round.items.map((item) => <Flex key={item.id} py="3" borderBottomWidth="1px" borderColor="border.subtle" justify="space-between" align="center" gap="3"><Flex align="center" gap="3"><Film size={14} aria-hidden /><Box><Text fontSize="13px" fontWeight="650">{item.clipTitle}</Text><Text fontSize="12px" color="fg.subtle">{item.required ? "Required" : "Optional"} · {item.export.variants.map((variant) => aspectLabel(variant.aspectRatio)).join(", ")}</Text></Box></Flex><Flex align="center" gap="2"><Box w="7px" h="7px" borderRadius="2px" bg={item.currentDecision === "approved" ? "success.solid" : item.currentDecision === "changes_requested" ? "warning.solid" : "fg.subtle"} /><Text textStyle="eyebrow" color="fg.muted">{(item.currentDecision ?? "awaiting decision").replaceAll("_", " ")}</Text></Flex></Flex>)}
            </Stack>
          </Stack>

          <Stack w={{ base: "full", lg: "360px" }} flexShrink="0" gap="5">
            <Box>
                          <Flex align="center" justify="space-between" gap="3"><Flex gap="2" align="center"><Box color="fg.muted"><MessageSquareText size={16} /></Box><Text textStyle="eyebrow" color="fg.muted">Feedback</Text></Flex>{activeItem ? <Text fontSize="12px" color="fg.subtle" truncate>{activeItem.clipTitle}</Text> : null}</Flex>
              {replyTo ? <Flex mt="3" align="center" justify="space-between" gap="2" px="3" py="2" bg="bg.soft" borderRadius="l2"><Text fontSize="12px" color="fg.muted"><Reply size={11} style={{ display: "inline", marginRight: 5 }} />Replying in thread</Text><Button size="2xs" variant="ghost" aria-label="Cancel reply" onClick={() => { setReplyTo(null); setComment(""); }}><X size={12} /></Button></Flex> : null}
              {editingCommentId ? <Flex mt="3" align="center" justify="space-between" gap="2" px="3" py="2" bg="bg.soft" borderRadius="l2"><Text fontSize="12px" color="fg.muted"><Pencil size={11} style={{ display: "inline", marginRight: 5 }} />Editing your comment</Text><Button size="2xs" variant="ghost" aria-label="Cancel editing" onClick={() => { setEditingCommentId(null); setComment(""); }}><X size={12} /></Button></Flex> : null}
              <Textarea ref={commentRef} mt="3" rows={4} value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} placeholder="Describe what should change, or why this is approved" aria-label="Review comment" />
              <Flex mt="2" justify="space-between" align="center" gap="2" wrap="wrap"><Flex gap="1"><Button size="xs" variant="ghost" disabled={Boolean(replyTo || editingCommentId)} onClick={() => setCommentScope((current) => current === "clip" ? "round" : "clip")} color={commentScope === "round" ? "accent.fg" : "fg.muted"}>{commentScope === "round" ? "General feedback" : "Clip feedback"}</Button><Button size="xs" variant="ghost" disabled={Boolean(replyTo || editingCommentId || !activeItem || commentScope === "round")} onClick={() => setIncludeTimecode((current) => !current)} color={includeTimecode && commentScope === "clip" ? "accent.fg" : "fg.muted"}>{includeTimecode && commentScope === "clip" ? <Check size={12} /> : <X size={12} />} Attach playhead</Button></Flex><Button size="sm" variant="subtle" disabled={!comment.trim() || busy} onClick={() => void saveComment()}><Send size={13} /> {editingCommentId ? "Save" : replyTo ? "Reply" : "Comment"}</Button></Flex>
            </Box>

            <Stack gap="0">
                          {commentsForActiveItem.filter((entry) => entry.parentId === null).map((thread) => {
                const replies = commentsForActiveItem.filter((entry) => entry.parentId === thread.id);
                return <Box key={thread.id} py="4" borderBottomWidth="1px" borderColor="border.subtle"><Flex align="start" justify="space-between" gap="3"><Box><Flex gap="2" align="center"><Text fontSize="12px" fontWeight="600">{thread.authorName}</Text><Text fontSize="12px" color="fg.subtle">{thread.authorKind === "guest" ? "Reviewer" : "Team"}</Text></Flex>{thread.timestampSec !== null ? <Button variant="ghost" size="2xs" mt="1" color="accent.fg" onClick={() => { const video = activeItem ? videoRefs.current.get(activeItem.id) : undefined; if (video) { video.currentTime = thread.timestampSec ?? 0; void video.play(); } }}><Text textStyle="data">{formatTimecode(thread.timestampSec)}</Text></Button> : null}<Text fontSize="13px" color="fg.muted" mt="1" whiteSpace="pre-wrap">{thread.body}</Text>{thread.editedAt ? <Text fontSize="12px" color="fg.subtle" mt="1">Edited</Text> : null}</Box>{thread.resolvedAt ? <Box color="success.fg" display="flex" role="img" aria-label="Resolved"><CheckCircle2 size={14} aria-hidden /></Box> : null}</Flex>
                  {replies.map((entry) => <Box key={entry.id} ms="4" mt="3" ps="3" borderStartWidth="2px" borderColor="border.emphasized"><Text fontSize="12px" fontWeight="600">{entry.authorName}</Text><Text fontSize="12px" color="fg.muted" mt="0.5">{entry.body}</Text>{entry.canEdit ? <Flex gap="2" mt="1"><Button size="2xs" variant="ghost" onClick={() => { setEditingCommentId(entry.id); setReplyTo(null); setComment(entry.body); requestAnimationFrame(() => commentRef.current?.focus()); }}><Pencil size={11} /> Edit</Button><Button size="2xs" variant="ghost" colorPalette="danger" disabled={busy} onClick={() => void request(`comments/${entry.id}`, "DELETE").then((saved) => { if (saved) setNotice("Reply deleted."); })}><Trash2 size={11} /> Delete</Button></Flex> : null}</Box>)}
                  <Flex gap="2" mt="2"><Button size="2xs" variant="ghost" onClick={() => { setReplyTo(thread.id); setEditingCommentId(null); setComment(""); requestAnimationFrame(() => commentRef.current?.focus()); }}><Reply size={11} /> Reply</Button>{thread.canEdit ? <><Button size="2xs" variant="ghost" onClick={() => { setEditingCommentId(thread.id); setReplyTo(null); setComment(thread.body); requestAnimationFrame(() => commentRef.current?.focus()); }}><Pencil size={11} /> Edit</Button><Button size="2xs" variant="ghost" colorPalette="danger" disabled={replies.length > 0 || busy} onClick={() => void request(`comments/${thread.id}`, "DELETE").then((saved) => { if (saved) setNotice("Comment deleted."); })}><Trash2 size={11} /> Delete</Button></> : null}</Flex>
                </Box>;
              })}
            </Stack>

            <Box>
                          <Flex align="center" gap="2"><Box color="fg.muted"><UserRound size={16} /></Box><Text textStyle="eyebrow" color="fg.muted">Round decision</Text></Flex>
              <Text fontSize="12px" color="fg.muted" mt="2">{roundReady ? "Every required clip is approved. You can approve the full submission." : `${requiredCount - requiredApproved} required clip${requiredCount - requiredApproved === 1 ? " still needs" : "s still need"} approval.`}</Text>
              {round.status === "open" || round.status === "changes_requested" ? <Stack gap="2" mt="4"><Button colorPalette="brand" disabled={busy || !roundReady} onClick={() => void decide("approved", null)}><Check size={15} /> Approve round</Button><Button variant="subtle" disabled={busy} onClick={() => void decide("changes_requested", null)}>Request changes on round</Button></Stack> : <Text fontSize="13px" color="fg.muted" mt="3">This round is {round.status.replaceAll("_", " ")}.</Text>}
            </Box>
          </Stack>
        </Flex>
      </Box>
    </Box>
  );
}
