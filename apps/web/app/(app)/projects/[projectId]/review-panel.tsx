"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { Box, chakra, Flex, Input, NativeSelect, Stack, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { formatDateTime, formatDuration, formatTimecode } from "@/lib/format";
import { restoreCampaignSelection } from "./campaign-selection";

type Variant = { id: string; aspectRatio: string; durationSec: number | null };
type CandidateExport = { id: string; editorRevision: number; createdAt: string; variants: Variant[] };
type Candidate = { id: string; title: string; editorRevision: number; exports: CandidateExport[] };
type Comment = {
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
};
type Round = {
  id: string;
  revision: number;
  title: string;
  message: string | null;
  status: string;
  path: string | null;
  allowDownloads: boolean;
  approvalRequired: boolean;
  recipientEmails: string[];
  sentAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  decision: string | null;
  newerWorkAvailable: boolean;
  items: Array<{
    id: string;
    clipId: string;
    clipTitle: string;
    exportId: string;
    editorRevision: number;
    required: boolean;
    currentDecision: string | null;
    variants: Variant[];
  }>;
  comments: Comment[];
  guests: Array<{ id: string; displayName: string | null; email: string | null; firstSeenAt: string; lastSeenAt: string }>;
  auditEvents: Array<{ id: string; kind: string; targetId: string | null; createdAt: string }>;
  notifications: Array<{
    id: string;
    recipientEmail: string;
    kind: string;
    status: string;
    attemptCount: number;
    failureCode: string | null;
    sentAt: string | null;
    createdAt: string;
  }>;
  context: Array<{
    id: string;
    sourceCommentId: string;
    sourceRoundRevision: number;
    authorName: string;
    body: string;
    timestampSec: number | null;
    clipTitle: string | null;
  }>;
};

export type ReviewRoomData = {
  project: { title: string; workspace: { name: string } };
  candidates: Candidate[];
  rounds: Round[];
};

type DraftSelection = { exportId: string; variantIds: string[]; required: boolean };

const STATUS_BADGE_STATUS: Record<string, "pending" | "processing" | "completed" | "failed"> = {
  open: "processing",
  approved: "completed",
  changes_requested: "pending",
  expired: "pending",
  revoked: "failed",
  superseded: "pending",
};

function aspectLabel(value: string) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

function eventLabel(value: string) {
  return value.replaceAll("_", " ");
}

function parseRecipients(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export function ReviewPanel({ projectId, initialData, canManage }: { projectId: string; initialData: ReviewRoomData; canManage: boolean }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [activeRoundId, setActiveRoundId] = useState(initialData.rounds[0]?.id ?? null);
  const [creating, setCreating] = useState(canManage && initialData.rounds.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState(`${initialData.project.title} review`);
  const [message, setMessage] = useState("");
  const [passcode, setPasscode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [selections, setSelections] = useState<Record<string, DraftSelection>>({});
  const [contextCommentIds, setContextCommentIds] = useState<string[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const createHeadingRef = useRef<HTMLDivElement>(null);
  const selectionInitializedRef = useRef(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/review-rounds`;

  const activeRound = data.rounds.find((round) => round.id === activeRoundId) ?? data.rounds[0] ?? null;
  const recipients = useMemo(() => parseRecipients(recipientText), [recipientText]);

  useEffect(() => {
    if (!creating || selectionInitializedRef.current || Object.keys(selections).length > 0) return;
    selectionInitializedRef.current = true;
    const restored = restoreCampaignSelection(
      window.sessionStorage,
      projectId,
      data.candidates.map((candidate) => candidate.id),
    );
    const selectedCandidates = data.candidates.filter((candidate) => restored.has(candidate.id));
    setSelections(Object.fromEntries(selectedCandidates.flatMap((candidate) => {
      const latest = candidate.exports[0];
      return latest ? [[candidate.id, { exportId: latest.id, variantIds: latest.variants.map((variant) => variant.id), required: true }]] : [];
    })));
  }, [creating, data.candidates, projectId, selections]);

  async function refresh() {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Review room could not be refreshed");
    setData(payload);
    setActiveRoundId((current) => current && payload.rounds.some((round: Round) => round.id === current) ? current : payload.rounds[0]?.id ?? null);
  }

  async function mutate(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Review action could not be completed");
      await refresh();
      router.refresh();
      return payload;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review action could not be completed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function updateSelection(clipId: string, change: Partial<DraftSelection>) {
    setSelections((current) => {
      const existing = current[clipId];
      if (!existing) return current;
      return { ...current, [clipId]: { ...existing, ...change } };
    });
  }

  function toggleCandidate(candidate: Candidate, checked: boolean) {
    setSelections((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      }
      const latest = candidate.exports[0];
      return latest
        ? { ...current, [candidate.id]: { exportId: latest.id, variantIds: latest.variants.map((variant) => variant.id), required: true } }
        : current;
    });
  }

  async function createRound() {
    const items = Object.entries(selections).flatMap(([clipId, selection]) => {
      const candidate = data.candidates.find((item) => item.id === clipId);
      const selectedExport = candidate?.exports.find((item) => item.id === selection.exportId);
      return candidate && selectedExport && selection.variantIds.length > 0
        ? [{ clipId, exportId: selectedExport.id, expectedEditorRevision: selectedExport.editorRevision, variantIds: selection.variantIds, required: selection.required }]
        : [];
    });
    if (!title.trim() || items.length === 0) {
      setError("Name the round and select at least one ready export.");
      createHeadingRef.current?.focus();
      return;
    }
    const result = await mutate("", {
      title: title.trim(),
      message: message.trim() || null,
      passcode: passcode || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      allowDownloads,
      approvalRequired,
      recipientEmails: recipients,
      contextCommentIds,
      items,
    });
    if (result) {
      setCreating(false);
      setPasscode("");
      setContextCommentIds([]);
      setNotice("Review round sent. The submitted exports are now immutable.");
    }
  }

  function prepareNext(round: Round) {
    setTitle(`${data.project.title} review ${String(round.revision + 1).padStart(2, "0")}`);
    const unresolved = round.comments.filter((comment) => comment.resolvedAt === null && comment.parentId === null);
    setContextCommentIds(unresolved.map((comment) => comment.id));
    setMessage(unresolved.length > 0 ? `Follow-up to round ${round.revision}. ${unresolved.length} feedback thread${unresolved.length === 1 ? " remains" : "s remain"} open.` : `Follow-up to round ${round.revision}.`);
    setRecipientText(round.recipientEmails.join(", "));
    setAllowDownloads(round.allowDownloads);
    setApprovalRequired(round.approvalRequired);
    setExpiresAt("");
    setPasscode("");
    setSelections(Object.fromEntries(round.items.flatMap((item) => {
      const candidate = data.candidates.find((entry) => entry.id === item.clipId);
      const latest = candidate?.exports[0];
      return latest ? [[item.clipId, { exportId: latest.id, variantIds: latest.variants.map((variant) => variant.id), required: item.required }]] : [];
    })));
    setCreating(true);
    requestAnimationFrame(() => createHeadingRef.current?.focus());
  }

  async function copyLink(round: Round) {
    if (!round.path) return;
    await navigator.clipboard.writeText(new URL(round.path, window.location.origin).toString());
    setNotice("Private review link copied.");
  }

  async function submitReply(round: Round) {
    if (!replyBody.trim()) return;
    const mentionRecipients = round.recipientEmails.filter((email) => replyBody.toLowerCase().includes(`@${email.toLowerCase()}`));
    const parent = replyParentId ? round.comments.find((comment) => comment.id === replyParentId) : null;
    const result = await mutate(`/${round.id}/comments`, {
      itemId: parent?.itemId ?? null,
      parentId: parent?.id ?? null,
      body: replyBody.trim(),
      timestampSec: null,
      mentionRecipients,
    });
    if (result) {
      setReplyBody("");
      setReplyParentId(null);
      setNotice("Reply added.");
      replyRef.current?.focus();
    }
  }

  return (
    <Stack gap="6">
      <Flex align={{ base: "stretch", md: "end" }} justify="space-between" gap="4" direction={{ base: "column", md: "row" }} borderBottomWidth="1px" borderColor="border" pb="5">
        <Box>
          <Text textStyle="eyebrow" color="accent.fg">Client delivery</Text>
          <Text textStyle="display" fontSize={{ base: "28px", md: "36px" }} mt="1">Review room</Text>
          <Text color="fg.muted" fontSize="sm" mt="1" maxW="620px">Submit exact export revisions, keep client feedback in one record, and see what changed before the next round.</Text>
        </Box>
        {canManage ? <Button colorPalette="accent" variant={creating ? "outline" : "solid"} onClick={() => { setContextCommentIds([]); setCreating(true); requestAnimationFrame(() => createHeadingRef.current?.focus()); }} disabled={creating || data.candidates.length === 0}>
          <Send size={15} /> Create review
        </Button> : null}
      </Flex>

      {notice ? <Flex role="status" aria-live="polite" gap="2" align="center" color="success.fg" borderStartWidth="3px" borderColor="success.solid" ps="3" py="2"><Check size={14} /><Text fontSize="sm">{notice}</Text></Flex> : null}
      {error ? <Flex role="alert" gap="2" align="center" color="danger.fg" borderStartWidth="3px" borderColor="danger.solid" ps="3" py="2"><AlertTriangle size={14} /><Text fontSize="sm">{error}</Text></Flex> : null}

      {canManage && creating ? (
        <Box layerStyle="blueprint" borderWidth="1px" borderColor="border" borderRadius="l2" overflow="hidden">
          <Flex px={{ base: "4", md: "6" }} py="4" borderBottomWidth="1px" borderColor="border" justify="space-between" align="start" gap="4">
            <Box ref={createHeadingRef} tabIndex={-1} outline="none">
              <Text textStyle="eyebrow" color="fg.subtle">New immutable submission</Text>
              <Text textStyle="title" fontSize="lg" mt="1">Choose what the client will see</Text>
            </Box>
            {data.rounds.length > 0 ? <Button size="xs" variant="ghost" onClick={() => setCreating(false)}><X size={14} /> Close</Button> : null}
          </Flex>
          <Flex direction={{ base: "column", xl: "row" }}>
            <Stack flex="1.25" gap="0" borderEndWidth={{ xl: "1px" }} borderColor="border">
              {data.candidates.map((candidate, index) => {
                const selection = selections[candidate.id];
                const selectedExport = candidate.exports.find((item) => item.id === selection?.exportId) ?? candidate.exports[0];
                return (
                  <Box key={candidate.id} px={{ base: "4", md: "6" }} py="4" borderBottomWidth={index === data.candidates.length - 1 ? "0" : "1px"} borderColor="border.subtle" bg={selection ? "bg.panel" : "transparent"}>
                    <Flex align="start" gap="3">
                      <Checkbox checked={Boolean(selection)} onCheckedChange={(checked) => toggleCandidate(candidate, checked)} aria-label={`Include ${candidate.title}`} mt="0.5" />
                      <Stack gap="3" flex="1" minW="0">
                        <Flex justify="space-between" gap="3" align="start">
                          <Box minW="0"><Text fontSize="sm" fontWeight="650" truncate>{candidate.title}</Text><Text fontSize="11px" color="fg.subtle">Current editor revision {candidate.editorRevision}</Text></Box>
                          {selection ? <Checkbox checked={selection.required} onCheckedChange={(checked) => updateSelection(candidate.id, { required: checked })}>Approval required</Checkbox> : null}
                        </Flex>
                        {selection && selectedExport ? (
                          <Stack gap="2">
                            <NativeSelect.Root size="sm">
                              <NativeSelect.Field aria-label={`Export revision for ${candidate.title}`} value={selection.exportId} onChange={(event) => {
                                const nextExport = candidate.exports.find((item) => item.id === event.target.value);
                                if (nextExport) updateSelection(candidate.id, { exportId: nextExport.id, variantIds: nextExport.variants.map((variant) => variant.id) });
                              }} borderColor="border.control" bg="bg.panel">
                                {candidate.exports.map((item, exportIndex) => <option key={item.id} value={item.id}>Revision {item.editorRevision}{exportIndex === 0 ? " · newest ready export" : ""}</option>)}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                            <Flex gap="2" wrap="wrap">
                              {selectedExport.variants.map((variant) => {
                                const checked = selection.variantIds.includes(variant.id);
                                return <Checkbox key={variant.id} checked={checked} onCheckedChange={(next) => updateSelection(candidate.id, { variantIds: next ? [...selection.variantIds, variant.id] : selection.variantIds.filter((id) => id !== variant.id) })}>{aspectLabel(variant.aspectRatio)}{variant.durationSec ? ` · ${formatDuration(variant.durationSec)}` : ""}</Checkbox>;
                              })}
                            </Flex>
                          </Stack>
                        ) : null}
                      </Stack>
                    </Flex>
                  </Box>
                );
              })}
            </Stack>
            <Stack flex="0.75" p={{ base: "4", md: "6" }} gap="4" bg="bg.panel">
              {contextCommentIds.length > 0 ? <Box borderStartWidth="3px" borderColor="accent.solid" ps="3" py="1"><Text textStyle="eyebrow" color="accent.fg">Linked prior feedback</Text><Text fontSize="12px" color="fg.muted" mt="1">{contextCommentIds.length} unresolved thread{contextCommentIds.length === 1 ? "" : "s"} will stay attached as internal context. The client note is not copied.</Text></Box> : null}
              <Stack gap="1.5"><chakra.label htmlFor="review-title" fontSize="12px" fontWeight="650">Round name</chakra.label><Input id="review-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} borderColor="border.control" /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="review-message" fontSize="12px" fontWeight="650">Note to reviewers</chakra.label><Textarea id="review-message" value={message} maxLength={2000} rows={3} onChange={(event) => setMessage(event.target.value)} borderColor="border.control" /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="review-recipients" fontSize="12px" fontWeight="650">Notification recipients</chakra.label><Textarea id="review-recipients" value={recipientText} rows={2} placeholder="client@example.com, producer@example.com" onChange={(event) => setRecipientText(event.target.value)} borderColor="border.control" /><Text fontSize="11px" color="fg.subtle">{recipients.length === 0 ? "The private link will only be copied, not emailed." : `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}</Text></Stack>
              <Flex gap="3" direction={{ base: "column", sm: "row" }}><Stack gap="1.5" flex="1"><chakra.label htmlFor="review-expiry" fontSize="12px" fontWeight="650">Expires</chakra.label><Input id="review-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} borderColor="border.control" /></Stack><Stack gap="1.5" flex="1"><chakra.label htmlFor="review-passcode" fontSize="12px" fontWeight="650">Passcode</chakra.label><Input id="review-passcode" type="password" minLength={6} maxLength={128} value={passcode} placeholder="Optional" onChange={(event) => setPasscode(event.target.value)} borderColor="border.control" /></Stack></Flex>
              <Stack gap="2"><Checkbox checked={allowDownloads} onCheckedChange={setAllowDownloads}>Allow downloads</Checkbox><Checkbox checked={approvalRequired} onCheckedChange={setApprovalRequired}>Require all selected clips before round approval</Checkbox></Stack>
              <Box borderTopWidth="1px" borderColor="border" pt="4"><Button w="full" colorPalette="accent" onClick={() => void createRound()} disabled={busy || Object.keys(selections).length === 0}>{busy ? <RefreshCw size={14} /> : <Send size={14} />}{busy ? " Sending…" : `Send round with ${Object.keys(selections).length} clip${Object.keys(selections).length === 1 ? "" : "s"}`}</Button><Text fontSize="11px" color="fg.subtle" mt="2">Sending freezes export revisions and replaces no prior feedback.</Text></Box>
            </Stack>
          </Flex>
        </Box>
      ) : null}

      {data.rounds.length === 0 && !creating ? <EmptyState title="No review rounds yet" description={canManage ? "Select ready exports and send a private room to collect timecoded feedback and approvals." : "A review round has not been sent yet."} /> : null}

      {data.rounds.length > 0 ? (
        <Flex align="start" direction={{ base: "column", lg: "row" }} gap="6">
          <Stack w={{ base: "full", lg: "300px" }} flexShrink="0" gap="0" borderTopWidth="1px" borderColor="border">
            {data.rounds.map((round) => {
              const approved = round.items.filter((item) => item.currentDecision === "approved").length;
              return <chakra.button key={round.id} type="button" textAlign="start" w="full" py="4" px="3" borderBottomWidth="1px" borderColor="border" borderStartWidth="3px" borderStartColor={activeRound?.id === round.id ? "accent.solid" : "transparent"} bg={activeRound?.id === round.id ? "bg.muted" : "transparent"} _hover={{ bg: "bg.muted" }} onClick={() => setActiveRoundId(round.id)} aria-pressed={activeRound?.id === round.id}>
                <Flex justify="space-between" gap="3"><Box minW="0"><Text textStyle="eyebrow" color="fg.subtle">Round {String(round.revision).padStart(2, "0")}</Text><Text fontSize="sm" fontWeight="650" mt="1" truncate>{round.title}</Text></Box><ChevronRight size={15} aria-hidden /></Flex>
                <Flex align="center" gap="2" mt="3"><StatusBadge label={eventLabel(round.status)} status={STATUS_BADGE_STATUS[round.status] ?? "pending"} /><Text textStyle="data" fontSize="11px" color="fg.subtle">{approved}/{round.items.length} approved</Text></Flex>
              </chakra.button>;
            })}
          </Stack>

          {activeRound ? (
            <Stack flex="1" minW="0" w="full" gap="6">
              <Box borderTopWidth="3px" borderColor="accent.solid" pt="4">
                <Flex justify="space-between" align="start" gap="4" wrap="wrap"><Box><Flex align="center" gap="2"><Text textStyle="eyebrow" color="fg.subtle">Round {String(activeRound.revision).padStart(2, "0")}</Text><StatusBadge label={eventLabel(activeRound.status)} status={STATUS_BADGE_STATUS[activeRound.status] ?? "pending"} /></Flex><Text textStyle="title" fontSize="xl" mt="2">{activeRound.title}</Text><Text fontSize="sm" color="fg.muted" mt="1">Sent {formatDateTime(activeRound.sentAt)} · {activeRound.items.length} clip{activeRound.items.length === 1 ? "" : "s"}</Text></Box>{canManage && activeRound.path ? <Flex gap="2" wrap="wrap"><Button size="sm" variant="outline" onClick={() => void copyLink(activeRound)}><Copy size={14} /> Copy link</Button><Button size="sm" variant="outline" asChild><a href={activeRound.path} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open room</a></Button></Flex> : null}</Flex>
                {activeRound.newerWorkAvailable ? <Flex mt="4" borderStartWidth="3px" borderColor="warning.solid" ps="3" py="2" gap="2" align="center" color="warning.fg"><AlertTriangle size={14} /><Text fontSize="sm">Newer ready work exists. This round still points to the exact exports the client saw.</Text></Flex> : null}
              </Box>

              <Flex gap="0" wrap="wrap" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border">
                <Stack px="4" py="3" gap="0" minW="150px"><Text textStyle="eyebrow" color="fg.subtle">Opened</Text><Text textStyle="data" fontSize="13px" mt="1">{activeRound.guests[0] ? formatDateTime(activeRound.guests[0].firstSeenAt) : "Not yet"}</Text></Stack>
                <Stack px="4" py="3" gap="0" borderStartWidth="1px" borderColor="border" minW="150px"><Text textStyle="eyebrow" color="fg.subtle">Decision</Text><Text textStyle="data" fontSize="13px" mt="1">{eventLabel(activeRound.decision ?? "pending")}</Text></Stack>
                <Stack px="4" py="3" gap="0" borderStartWidth="1px" borderColor="border" minW="150px"><Text textStyle="eyebrow" color="fg.subtle">Expires</Text><Text textStyle="data" fontSize="13px" mt="1">{activeRound.expiresAt ? formatDateTime(activeRound.expiresAt) : "No expiry"}</Text></Stack>
              </Flex>

              <Stack gap="0" borderTopWidth="1px" borderColor="border">
                {activeRound.items.map((item) => <Flex key={item.id} py="3" px="2" borderBottomWidth="1px" borderColor="border" align={{ base: "start", md: "center" }} direction={{ base: "column", md: "row" }} justify="space-between" gap="3"><Box><Text fontSize="sm" fontWeight="650">{item.clipTitle}</Text><Flex gap="2" mt="1" wrap="wrap"><Text textStyle="data" fontSize="11px" color="fg.subtle">Revision {item.editorRevision}</Text>{item.variants.map((variant) => <Text key={variant.id} textStyle="data" fontSize="11px" color="fg.subtle">{aspectLabel(variant.aspectRatio)}</Text>)}</Flex></Box><StatusBadge label={eventLabel(item.currentDecision ?? "awaiting decision")} status={item.currentDecision === "approved" ? "completed" : "pending"} /></Flex>)}
              </Stack>

              {activeRound.context.length > 0 ? <Box borderTopWidth="3px" borderColor="border.emphasized" pt="3"><Flex align="center" justify="space-between" gap="3"><Text textStyle="eyebrow">Prior unresolved context</Text><Text textStyle="data" fontSize="10px" color="fg.subtle">Internal only</Text></Flex><Stack gap="0" mt="2">{activeRound.context.map((context) => <Box key={context.id} py="3" borderBottomWidth="1px" borderColor="border.subtle"><Flex gap="2" wrap="wrap" align="center"><Text fontSize="11px" fontWeight="700">{context.authorName}</Text><Text textStyle="data" fontSize="10px" color="fg.subtle">Round {String(context.sourceRoundRevision).padStart(2, "0")}</Text>{context.clipTitle ? <Text fontSize="10px" color="fg.subtle">{context.clipTitle}</Text> : null}{context.timestampSec !== null ? <Text textStyle="data" fontSize="10px" color="accent.fg">{formatTimecode(context.timestampSec)}</Text> : null}</Flex><Text fontSize="12px" color="fg.muted" mt="1" whiteSpace="pre-wrap">{context.body}</Text></Box>)}</Stack></Box> : null}

              <Flex direction={{ base: "column", xl: "row" }} gap="6" align="start">
                <Stack flex="1" w="full" gap="4">
                  <Flex align="center" justify="space-between"><Flex align="center" gap="2"><MessageSquareText size={16} /><Text textStyle="eyebrow">Feedback</Text></Flex><Text textStyle="data" fontSize="11px" color="fg.subtle">{activeRound.comments.filter((comment) => !comment.parentId).length} threads</Text></Flex>
                  <Stack gap="0" borderTopWidth="1px" borderColor="border">
                    {activeRound.comments.filter((comment) => !comment.parentId).map((thread) => {
                      const replies = activeRound.comments.filter((comment) => comment.parentId === thread.id);
                      return <Box key={thread.id} borderBottomWidth="1px" borderColor="border" py="4"><Flex justify="space-between" gap="3" align="start"><Box><Flex align="center" gap="2"><Text fontSize="12px" fontWeight="700">{thread.authorName}</Text><Text fontSize="10px" color="fg.subtle">{thread.authorKind === "guest" ? "Client" : "Team"}</Text>{thread.timestampSec !== null ? <Text textStyle="data" color="accent.fg" fontSize="11px">{formatTimecode(thread.timestampSec)}</Text> : null}</Flex><Text fontSize="13px" color="fg.muted" mt="1" whiteSpace="pre-wrap">{thread.body}</Text></Box><StatusBadge label={thread.resolvedAt ? "resolved" : "open"} status={thread.resolvedAt ? "completed" : "pending"} /></Flex>{replies.map((reply) => <Box key={reply.id} ms="5" mt="3" ps="3" borderStartWidth="2px" borderColor="border.emphasized"><Text fontSize="11px" fontWeight="700">{reply.authorName}</Text><Text fontSize="13px" color="fg.muted" mt="0.5">{reply.body}</Text></Box>)}{canManage ? <Flex gap="2" mt="3"><Button size="xs" variant="ghost" onClick={() => { setReplyParentId(thread.id); setReplyBody(""); requestAnimationFrame(() => replyRef.current?.focus()); }}>Reply</Button><Button size="xs" variant="ghost" onClick={() => void mutate(`/${activeRound.id}/comments/${thread.id}/${thread.resolvedAt ? "reopen" : "resolve"}`)} disabled={busy}>{thread.resolvedAt ? <RotateCcw size={12} /> : <Check size={12} />}{thread.resolvedAt ? "Reopen" : "Resolve"}</Button></Flex> : null}</Box>;
                    })}
                  </Stack>
                  {canManage ? <Box borderTopWidth="3px" borderColor="border.emphasized" pt="3"><Text fontSize="12px" fontWeight="650">{replyParentId ? "Reply to thread" : "Add team note"}</Text><Textarea ref={replyRef} mt="2" rows={3} value={replyBody} onChange={(event) => setReplyBody(event.target.value.slice(0, 2000))} placeholder={activeRound.recipientEmails.length > 0 ? `Mention a recipient with @${activeRound.recipientEmails[0]}` : "Write a clear response"} borderColor="border.control" /><Flex mt="2" justify="space-between" gap="2"><Button size="xs" variant="ghost" disabled={!replyParentId} onClick={() => { setReplyParentId(null); setReplyBody(""); }}>Cancel reply</Button><Button size="sm" variant="outline" disabled={!replyBody.trim() || busy} onClick={() => void submitReply(activeRound)}><Send size={13} /> Add reply</Button></Flex></Box> : null}
                </Stack>

                <Stack w={{ base: "full", xl: "310px" }} flexShrink="0" gap="5">
                  <Box borderTopWidth="3px" borderColor="border.emphasized" pt="3"><Flex align="center" gap="2"><UserRound size={15} /><Text textStyle="eyebrow">Reviewers</Text></Flex>{activeRound.guests.length === 0 ? <Text fontSize="13px" color="fg.muted" mt="3">Nobody has opened the room.</Text> : canManage ? activeRound.guests.map((guest) => <Box key={guest.id} py="3" borderBottomWidth="1px" borderColor="border.subtle"><Text fontSize="13px" fontWeight="650">{guest.displayName}</Text><Text fontSize="11px" color="fg.subtle">{guest.email}</Text><Text fontSize="10px" color="fg.subtle" mt="1">Last seen {formatDateTime(guest.lastSeenAt)}</Text></Box>) : <Text fontSize="13px" color="fg.muted" mt="3">{activeRound.guests.length} reviewer{activeRound.guests.length === 1 ? " has" : "s have"} opened the room.</Text>}</Box>
                  {canManage ? <Box borderTopWidth="3px" borderColor="border.emphasized" pt="3"><Flex align="center" gap="2"><Send size={15} /><Text textStyle="eyebrow">Delivery</Text></Flex>{activeRound.recipientEmails.length > 0 ? <Stack gap="1" mt="3">{activeRound.recipientEmails.map((email) => <Text key={email} fontSize="12px">{email}</Text>)}</Stack> : <Text fontSize="13px" color="fg.muted" mt="3">No email recipients were configured.</Text>}{activeRound.recipientEmails.length > 0 && activeRound.notifications.length === 0 ? <Text fontSize="11px" color="fg.subtle" mt="2">Email delivery was paused when this round was sent.</Text> : activeRound.notifications.map((notification) => <Flex key={notification.id} py="3" borderBottomWidth="1px" borderColor="border.subtle" justify="space-between" gap="2" align="start"><Box minW="0"><Text fontSize="12px" truncate>{notification.recipientEmail}</Text><Text fontSize="10px" color="fg.subtle">{eventLabel(notification.kind)} · {notification.status}</Text>{notification.failureCode ? <Text fontSize="10px" color="danger.fg">{eventLabel(notification.failureCode)}</Text> : null}</Box>{notification.status === "failed" ? <Button size="xs" variant="ghost" onClick={() => void mutate(`/${activeRound.id}/notifications/retry`, { ledgerId: notification.id })} disabled={busy}><RefreshCw size={12} /> Retry</Button> : null}</Flex>)}</Box> : null}
                  {canManage ? <Box borderTopWidth="3px" borderColor="border.emphasized" pt="3"><Flex align="center" gap="2"><Clock3 size={15} /><Text textStyle="eyebrow">Audit history</Text></Flex><Stack gap="0" mt="2">{activeRound.auditEvents.slice(0, 12).map((event) => <Flex key={event.id} py="2" borderBottomWidth="1px" borderColor="border.subtle" justify="space-between" gap="3"><Text fontSize="11px">{eventLabel(event.kind)}</Text><Text textStyle="data" fontSize="10px" color="fg.subtle">{formatDateTime(event.createdAt)}</Text></Flex>)}</Stack></Box> : null}
                </Stack>
              </Flex>

              {canManage ? <Flex borderTopWidth="1px" borderColor="border" pt="4" justify="space-between" gap="3" wrap="wrap"><Button variant="outline" onClick={() => prepareNext(activeRound)}><RefreshCw size={14} /> Prepare next round</Button>{!activeRound.revokedAt ? <Button variant="ghost" colorPalette="danger" onClick={() => void mutate(`/${activeRound.id}/revoke`)} disabled={busy}><ShieldCheck size={14} /> Revoke access</Button> : null}</Flex> : null}
            </Stack>
          ) : null}
        </Flex>
      ) : null}
    </Stack>
  );
}
