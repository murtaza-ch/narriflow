"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReviewPreselection } from "@/lib/review-preselection";
import { createReviewsClient, reviewQueries, reviewMutationOptions, invalidateReviewMutation } from "@narriflow/api-client/reviews";
import { isApiError, type Intent } from "@narriflow/api-client/core";
import type { CreateReviewRoundInput, InternalReviewCommentInput, InviteReviewersInput } from "@narriflow/validators";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import {
  AlertTriangle,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  MessageSquare,
  MessageSquareText,
  Play,
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
import { PanelHeader } from "./panel-header";
import { formatDateTime, formatDuration, formatTimecode } from "@/lib/format";
import { restoreCampaignSelection } from "./campaign-selection";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { LockedButton, useUpgrade } from "../../_components/upgrade";
import { FeatureHero } from "../../_components/feature-hero";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { type RoundPick, shownRound } from "./project-share-model";

type Variant = { id: string; aspectRatio: string; durationSec: number | null };
type CandidateExport = { id: string; editorRevision: number; createdAt: string; variants: Variant[] };
export type ReviewCandidate = { id: string; title: string; editorRevision: number; exports: CandidateExport[] };
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
export type ReviewRound = {
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
  project: { title: string; workspace: { name: string }; approvalRequiredByDefault: boolean };
  candidates: ReviewCandidate[];
  rounds: ReviewRound[];
};

export type ReviewCommand =
  | { kind: "create"; input: CreateReviewRoundInput }
  | { kind: "invite"; roundId: string; input: InviteReviewersInput }
  | { kind: "comment"; roundId: string; input: InternalReviewCommentInput }
  | { kind: "resolve" | "reopen"; roundId: string; commentId: string }
  | { kind: "retry"; roundId: string; ledgerId: string }
  | { kind: "revoke"; roundId: string };

function reviewCommandIdentity(command: ReviewCommand): string {
  if (command.kind === "create") return "create";
  const target = command.kind === "resolve" || command.kind === "reopen" ? command.commentId
    : command.kind === "retry" ? command.ledgerId
    : command.kind === "comment" ? `${command.input.itemId ?? "round"}:${command.input.parentId ?? "root"}` : "";
  return `${command.kind}:${command.roundId}:${target}`;
}

/** Both internal review surfaces share the captured Workspace room and commands. */
export function useInternalReviews(projectId: string, initialData?: ReviewRoomData, enabled = true) {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const queryClient = useQueryClient();
  const api = useMemo(() => {
    const captured = scope ?? { userId: "", workspaceId: "" };
    return { scope: captured, projectId, client: createReviewsClient(runtime.transport.scoped(captured)), intents: new Map<string, Intent<ReviewCommand>>() };
  }, [runtime, scope, projectId]);
  const roomOptions = reviewQueries.room(api.client, api.scope, api.projectId);
  const room = useQuery<ReviewRoomData>({
    ...roomOptions,
    queryFn: async ({ signal }): Promise<ReviewRoomData> => {
      const value = await roomOptions.queryFn({ signal });
      return {
        ...value,
        candidates: value.candidates.map((candidate) => ({ ...candidate, title: candidate.title ?? "" })),
        rounds: value.rounds.map((round) => ({ ...round, items: round.items.map((item) => ({ ...item, clipTitle: item.clipTitle ?? "" })) })),
      };
    },
    initialData,
    enabled: enabled && scope !== null,
  });
  const mutation = useMutation({
    ...reviewMutationOptions,
    mutationFn: async (command: ReviewCommand) => {
      const root = api.client.projects[":id"]["review-rounds"];
      const param = { id: api.projectId };
      const identity = reviewCommandIdentity(command);
      let intent = api.intents.get(identity);
      if (!intent) { intent = runtime.createIntent<ReviewCommand>(); api.intents.set(identity, intent); }
      const options = { headers: { "Idempotency-Key": intent.keyFor(command) } };
      if (command.kind === "create") return (await root.$post({ param, json: command.input }, options)).json();
      const round = root[":roundId"];
      const roundParam = { ...param, roundId: command.roundId };
      switch (command.kind) {
        case "invite": return (await round.invite.$post({ param: roundParam, json: command.input }, options)).json();
        case "comment": return (await round.comments.$post({ param: roundParam, json: command.input }, options)).json();
        case "resolve": case "reopen": return (await round.comments[":commentId"][command.kind].$post({ param: { ...roundParam, commentId: command.commentId } }, options)).json();
        case "retry": return (await round.notifications.retry.$post({ param: roundParam, json: { ledgerId: command.ledgerId } }, options)).json();
        case "revoke": return (await round.revoke.$post({ param: roundParam }, options)).json();
      }
    },
    onSuccess: async (_result, command) => {
      api.intents.delete(reviewCommandIdentity(command));
      await invalidateReviewMutation(queryClient, api.scope, api.projectId);
    },
  });
  return { room, mutation };
}

function reviewFailurePrompt(reason: unknown) {
  return isApiError(reason) ? upgradePromptFromFailure({ error: reason.code, message: reason.message, ...(reason.details ? { details: reason.details } : {}) }) : null;
}

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

const CLIP_FILLS = [
  "linear-gradient(140deg,#c1d2f2,#5c6c96)",
  "linear-gradient(135deg,#8cace0,#31486f)",
  "linear-gradient(140deg,#c9bcf0,#74619e)",
];

/** A small stand-in for a clip: the app has no thumbnail for an export, so tiles are decorative. */
function ClipTile({ index }: { index: number }) {
  return (
    <Flex flexShrink={0} w="30px" h="46px" align="center" justify="center" borderRadius="6px" color="white" aria-hidden style={{ backgroundImage: CLIP_FILLS[index % CLIP_FILLS.length] }}>
      <Play size={11} fill="currentColor" />
    </Flex>
  );
}

function Initials({ name, guest = false }: { name: string; guest?: boolean }) {
  return (
    <Flex boxSize="8" flexShrink={0} align="center" justify="center" borderRadius="full" bg={guest ? "accent.muted" : "bg.soft"} color={guest ? "accent.fg" : "fg.muted"} fontSize="12px" fontWeight="600" aria-hidden>
      {(name.trim().charAt(0) || "?").toUpperCase()}
    </Flex>
  );
}

function ApprovalMeter({ approved, total }: { approved: number; total: number }) {
  return (
    <Flex align="center" gap="3">
      <Box flex="1" h="6px" bg="bg.soft" borderRadius="full" overflow="hidden" aria-hidden>
        <Box h="full" w={`${total > 0 ? Math.round((approved / total) * 100) : 0}%`} bg="accent.solid" borderRadius="full" transition="width 0.3s ease" />
      </Box>
      <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle" whiteSpace="nowrap">{approved}/{total} approved</Text>
    </Flex>
  );
}

function SideCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Stack gap="3" p="4" bg="bg.subtle" borderRadius="l3">
      <Flex align="center" gap="2" color="fg.muted">
        {icon}
        <Text textStyle="eyebrow">{title}</Text>
      </Flex>
      {children}
    </Stack>
  );
}

/** What a review round is, drawn: clips to watch, a comment pinned to a moment, an approval. */
function ReviewHeroVisual() {
  return (
    <Box position="absolute" inset="0">
      <Flex position="absolute" inset="0" align="center" justify="center" ps="4" pt="2">
        {CLIP_FILLS.map((fill, index) => (
          <Flex
            key={fill}
            position="relative"
            w="76px"
            h="132px"
            ms={index ? "-10px" : "0"}
            zIndex={index === 1 ? 1 : 0}
            align="center"
            justify="center"
            borderRadius="12px"
            color="white"
            transform={`rotate(${(index - 1) * 8}deg)${index === 1 ? " translateY(-6px)" : ""}`}
            style={{ backgroundImage: fill }}
          >
            {index === 1 ? (
              <>
                <Play size={18} fill="currentColor" />
                <Box position="absolute" insetX="2.5" bottom="3" h="3px" borderRadius="full" bg="whiteAlpha.500">
                  <Box w="34%" h="full" borderRadius="full" bg="white" />
                  <Box position="absolute" left="34%" top="50%" boxSize="9px" ms="-4px" mt="-4.5px" borderRadius="full" bg="white" />
                </Box>
              </>
            ) : null}
          </Flex>
        ))}
      </Flex>
      <Flex position="absolute" zIndex="2" top="16%" right="6%" align="center" gap="1.5" px="3" py="2" bg="bg.panel" borderRadius="12px 12px 12px 3px" fontSize="12px" color="fg">
        <MessageSquare size={12} />
        Love this hook
        <Text as="span" textStyle="data" fontSize="11px" color="accent.fg">0:04</Text>
      </Flex>
      <Flex position="absolute" zIndex="2" bottom="14%" left="8%" align="center" gap="1" h="7" px="3" bg="bg.panel" color="accent.fg" borderRadius="full" fontSize="12px" fontWeight="500">
        <Check size={13} />
        Approved
      </Flex>
    </Box>
  );
}

function parseRecipients(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export function ReviewPanel({ projectId, initialData, canManage, preselection = null }: { projectId: string; initialData: ReviewRoomData; canManage: boolean; preselection?: ReviewPreselection | null }) {
  const { room, mutation } = useInternalReviews(projectId, initialData);
  const { openUpgrade, currentTier } = useUpgrade();
  const reviewUpgrade = featureUpgradePrompt(currentTier, "review.rooms", "Upgrade to share projects for client review");
  const data = room.data ?? initialData;
  const [roundPick, setRoundPick] = useState<RoundPick | null>(null);
  // An assistant's review handoff opens the composer with its checked exports;
  // the member still chooses recipients, passcode, expiry, and sends.
  const [creating, setCreating] = useState(Boolean(preselection && Object.keys(preselection.selections).length > 0));
  const busy = mutation.isPending;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(preselection?.dropped
    ? `${preselection.dropped} selected export${preselection.dropped === 1 ? " is" : "s are"} no longer current and ${preselection.dropped === 1 ? "was" : "were"} left out.`
    : null);
  const [title, setTitle] = useState(`${initialData.project.title} review`);
  const [message, setMessage] = useState("");
  const [passcode, setPasscode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(
	initialData.project.approvalRequiredByDefault,
	);
  const [selections, setSelections] = useState<Record<string, DraftSelection>>(preselection?.selections ?? {});
  const [contextCommentIds, setContextCommentIds] = useState<string[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const createHeadingRef = useRef<HTMLDivElement>(null);
  const selectionInitializedRef = useRef(false);


  const activeRound = shownRound(data.rounds, roundPick);
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

  async function mutate(command: ReviewCommand) {
    setError(null);
    setNotice(null);
    try {
      return await mutation.mutateAsync(command);
    } catch (reason) {
      const prompt = reviewFailurePrompt(reason);
      if (prompt) openUpgrade(prompt);
      setError(reason instanceof Error ? reason.message : "Review action could not be completed");
      return null;
    }
  }

  function updateSelection(clipId: string, change: Partial<DraftSelection>) {
    setSelections((current) => {
      const existing = current[clipId];
      if (!existing) return current;
      return { ...current, [clipId]: { ...existing, ...change } };
    });
  }

  function toggleCandidate(candidate: ReviewCandidate, checked: boolean) {
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
    const result = await mutate({ kind: "create", input: {
      title: title.trim(),
      message: message.trim() || null,
      passcode: passcode || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      allowDownloads,
      approvalRequired,
      recipientEmails: recipients,
      contextCommentIds,
      items,
    } });
    if (result) {
      setCreating(false);
      setPasscode("");
      setContextCommentIds([]);
      setNotice("Review round sent. The submitted exports are now immutable.");
    }
  }

  function prepareNext(round: ReviewRound) {
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

  function startRound() {
    setContextCommentIds([]);
    setCreating(true);
    requestAnimationFrame(() => createHeadingRef.current?.focus());
  }

  async function copyLink(round: ReviewRound) {
    if (!round.path) return;
    await navigator.clipboard.writeText(new URL(round.path, window.location.origin).toString());
    setNotice("Private review link copied.");
  }

  async function submitReply(round: ReviewRound) {
    if (!replyBody.trim()) return;
    const mentionRecipients = round.recipientEmails.filter((email) => replyBody.toLowerCase().includes(`@${email.toLowerCase()}`));
    const parent = replyParentId ? round.comments.find((comment) => comment.id === replyParentId) : null;
    const result = await mutate({ kind: "comment", roundId: round.id, input: {
      itemId: parent?.itemId ?? null,
      parentId: parent?.id ?? null,
      body: replyBody.trim(),
      timestampSec: null,
      mentionRecipients,
    } });
    if (result) {
      setReplyBody("");
      setReplyParentId(null);
      setNotice("Reply added.");
      replyRef.current?.focus();
    }
  }

  return (
    <Stack gap="6">
      <PanelHeader
        icon={<Send size={20} />}
        title="Review history"
        description="Send rounds for review and read the feedback."
        // While the empty-state explainer shows, its button is the one entry point.
        actions={canManage && (data.rounds.length > 0 || creating) ? reviewUpgrade && !creating ? (
          // The plan is the first thing in the way, so say so before the form is filled in.
          <LockedButton size="sm" prompt={reviewUpgrade}>
            <Send size={14} /> New round
          </LockedButton>
        ) : <Button size="sm" colorPalette="brand" variant={creating ? "subtle" : "solid"} onClick={startRound} disabled={creating || data.candidates.length === 0}>
          <Send size={14} /> New round
        </Button> : null}
      />

      {notice ? <Flex role="status" aria-live="polite" gap="2" align="center" bg="accent.subtle" color="accent.fg" borderRadius="l2" px="3" py="2.5"><Check size={14} /><Text fontSize="sm">{notice}</Text></Flex> : null}
      {error ? <Flex role="alert" gap="2" align="center" bg="danger.subtle" color="danger.fg" borderRadius="l2" px="3" py="2.5"><AlertTriangle size={14} /><Text fontSize="sm">{error}</Text></Flex> : null}

      {canManage && creating ? (
        <Stack gap="4">
          <Flex justify="space-between" align="center" gap="4">
            <Box ref={createHeadingRef} tabIndex={-1} outline="none">
              <Text fontSize="16px" fontWeight="500">Choose what reviewers will see</Text>
            </Box>
            {data.rounds.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setCreating(false)}><X size={14} /> Close</Button> : null}
          </Flex>
          <Flex direction={{ base: "column", xl: "row" }} gap="4" align="start">
            <Stack flex="1.25" w="full" minW="0" gap="2">
              {data.candidates.map((candidate, index) => {
                const selection = selections[candidate.id];
                const selectedExport = candidate.exports.find((item) => item.id === selection?.exportId) ?? candidate.exports[0];
                return (
                  <Box key={candidate.id} p="4" borderRadius="l3" bg={selection ? "accent.subtle" : "bg.subtle"} transition="background 0.15s ease">
                    <Flex align="start" gap="3">
                      <Checkbox checked={Boolean(selection)} onCheckedChange={(checked) => toggleCandidate(candidate, checked)} aria-label={`Include ${candidate.title}`} mt="0.5" />
                      <ClipTile index={index} />
                      <Stack gap="3" flex="1" minW="0">
                        <Flex justify="space-between" gap="3" align="start">
                          <Box minW="0"><Text fontSize="sm" fontWeight="550" truncate>{candidate.title}</Text><Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">Editor revision {candidate.editorRevision}</Text></Box>
                          {selection ? <Checkbox checked={selection.required} onCheckedChange={(checked) => updateSelection(candidate.id, { required: checked })}>Approval required</Checkbox> : null}
                        </Flex>
                        {selection && selectedExport ? (
                          <Stack gap="2">
                            <NativeSelect.Root size="sm">
                              <NativeSelect.Field aria-label={`Export revision for ${candidate.title}`} value={selection.exportId} onChange={(event) => {
                                const nextExport = candidate.exports.find((item) => item.id === event.target.value);
                                if (nextExport) updateSelection(candidate.id, { exportId: nextExport.id, variantIds: nextExport.variants.map((variant) => variant.id) });
                              }}>
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
            <Stack flex="0.75" w="full" p={{ base: "4", md: "6" }} gap="4" bg="bg.subtle" borderRadius="l3">
              {contextCommentIds.length > 0 ? <Box bg="accent.subtle" borderRadius="l2" p="3"><Text textStyle="eyebrow" color="accent.fg">Carried-over feedback</Text><Text fontSize="12px" color="fg.muted" mt="1">{contextCommentIds.length} open thread{contextCommentIds.length === 1 ? "" : "s"} from the last round come along as internal notes. Your note to reviewers is not copied.</Text></Box> : null}
              <Stack gap="1.5"><chakra.label htmlFor="review-title" fontSize="12px" fontWeight="650">Round name</chakra.label><Input id="review-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="review-message" fontSize="12px" fontWeight="650">Note to reviewers</chakra.label><Textarea id="review-message" value={message} maxLength={2000} rows={3} onChange={(event) => setMessage(event.target.value)} /></Stack>
              <Stack gap="1.5"><chakra.label htmlFor="review-recipients" fontSize="12px" fontWeight="650">Notification recipients</chakra.label><Textarea id="review-recipients" value={recipientText} rows={2} placeholder="client@example.com, producer@example.com" onChange={(event) => setRecipientText(event.target.value)} /><Text fontSize="12px" color="fg.subtle">{recipients.length === 0 ? "The private link will only be copied, not emailed." : `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}</Text></Stack>
              <Flex gap="3" direction={{ base: "column", sm: "row" }}><Stack gap="1.5" flex="1"><chakra.label htmlFor="review-expiry" fontSize="12px" fontWeight="650">Expires</chakra.label><Input id="review-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Stack><Stack gap="1.5" flex="1"><chakra.label htmlFor="review-passcode" fontSize="12px" fontWeight="650">Passcode</chakra.label><Input id="review-passcode" type="password" minLength={6} maxLength={128} value={passcode} placeholder="Optional" onChange={(event) => setPasscode(event.target.value)} /></Stack></Flex>
              <Stack gap="2"><Checkbox checked={allowDownloads} onCheckedChange={setAllowDownloads}>Allow downloads</Checkbox><Checkbox checked={approvalRequired} onCheckedChange={setApprovalRequired}>Clips need approval before they publish</Checkbox><Text fontSize="12px" color="fg.subtle">{data.project.approvalRequiredByDefault ? "Your Brand Profile turns this on by default." : "Your Brand Profile leaves this off by default."} You can't change it after sending.</Text></Stack>
              <Box pt="2">
                {reviewUpgrade ? (
                  <LockedButton w="full" prompt={reviewUpgrade} disabled={busy || Object.keys(selections).length === 0}>
                    <Send size={14} /> Send round with {Object.keys(selections).length} clip{Object.keys(selections).length === 1 ? "" : "s"}
                  </LockedButton>
                ) : (
                  <Button w="full" colorPalette="brand" onClick={() => void createRound()} disabled={busy || Object.keys(selections).length === 0}>{busy ? <RefreshCw size={14} /> : <Send size={14} />}{busy ? " Sending…" : `Send round with ${Object.keys(selections).length} clip${Object.keys(selections).length === 1 ? "" : "s"}`}</Button>
                )}
                <Text fontSize="12px" color="fg.subtle" mt="2">Sending locks these exact exports. Earlier feedback stays as it is.</Text>
              </Box>
            </Stack>
          </Flex>
        </Stack>
      ) : null}

      {data.rounds.length === 0 && !creating ? (
        canManage ? (
          <FeatureHero
            title="Get sign-off without sending files"
            points={[
              "Pick the finished exports to share.",
              "One private link, optional passcode and expiry.",
              "Comments pinned to moments, plus approval.",
            ]}
            visual={<ReviewHeroVisual />}
            action={
              <Flex align="center" gap="3" wrap="wrap">
                {reviewUpgrade ? (
                  <LockedButton size="sm" prompt={reviewUpgrade}>
                    <Send size={14} /> Start a review round
                  </LockedButton>
                ) : (
                  <Button size="sm" onClick={startRound} disabled={data.candidates.length === 0}>
                    <Send size={14} /> Start a review round
                  </Button>
                )}
                {!reviewUpgrade && data.candidates.length === 0 ? (
                  <Text fontSize="12px" color="fg.subtle">Export a clip first. Rounds share finished exports.</Text>
                ) : null}
              </Flex>
            }
          />
        ) : (
          <EmptyState title="No review rounds yet" description="No exports shared for review." />
        )
      ) : null}

      {data.rounds.length > 0 ? (
        <Flex align="start" direction={{ base: "column", lg: "row" }} gap="6">
          <Stack w={{ base: "full", lg: "300px" }} flexShrink="0" gap="2">
            {data.rounds.map((round) => {
              const approved = round.items.filter((item) => item.currentDecision === "approved").length;
              const selected = activeRound?.id === round.id;
              return (
                <chakra.button key={round.id} type="button" textAlign="start" w="full" p="4" borderRadius="l3" bg={selected ? "accent.subtle" : "bg.subtle"} transition="background 0.15s ease" _hover={{ bg: selected ? "accent.subtle" : "bg.soft" }} onClick={() => setRoundPick({ id: round.id, newestId: data.rounds[0]?.id ?? null })} aria-pressed={selected}>
                  <Flex justify="space-between" align="center" gap="3">
                    <Text textStyle="eyebrow" color={selected ? "accent.fg" : "fg.muted"}>Round {String(round.revision).padStart(2, "0")}</Text>
                    <StatusBadge label={eventLabel(round.status)} status={STATUS_BADGE_STATUS[round.status] ?? "pending"} />
                  </Flex>
                  <Text fontSize="sm" fontWeight="550" mt="2" truncate>{round.title}</Text>
                  <Box mt="3"><ApprovalMeter approved={approved} total={round.items.length} /></Box>
                </chakra.button>
              );
            })}
          </Stack>

          {activeRound ? (
            <Stack flex="1" minW="0" w="full" gap="5">
              <Stack gap="4" p={{ base: "4", md: "5" }} bg="bg.subtle" borderRadius="l3">
                <Flex justify="space-between" align="start" gap="4" wrap="wrap">
                  <Box minW="0">
                    <Flex align="center" gap="2"><Text textStyle="eyebrow" color="fg.muted">Round {String(activeRound.revision).padStart(2, "0")}</Text><StatusBadge label={eventLabel(activeRound.status)} status={STATUS_BADGE_STATUS[activeRound.status] ?? "pending"} /></Flex>
                    <Text textStyle="title" fontSize="xl" mt="2">{activeRound.title}</Text>
                    <Text fontSize="sm" color="fg.muted" mt="1">Sent {formatDateTime(activeRound.sentAt)} · {activeRound.items.length} clip{activeRound.items.length === 1 ? "" : "s"}</Text>
                  </Box>
                  {canManage && activeRound.path ? <Flex gap="2" wrap="wrap"><Button size="sm" variant="subtle" onClick={() => void copyLink(activeRound)}><Copy size={14} /> Copy link</Button><Button size="sm" variant="subtle" asChild><a href={activeRound.path} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open room</a></Button></Flex> : null}
                </Flex>
                {activeRound.items.length > 0 ? <ApprovalMeter approved={activeRound.items.filter((item) => item.currentDecision === "approved").length} total={activeRound.items.length} /> : null}
                {activeRound.newerWorkAvailable ? <Flex bg="warning.subtle" borderRadius="l2" px="3" py="2.5" gap="2" align="center" color="warning.fg"><AlertTriangle size={14} /><Text fontSize="sm">There is newer finished work. This round still shows the exact exports reviewers saw.</Text></Flex> : null}
                <Flex gap="2" wrap="wrap">
                  <Stack gap="0" flex="1" minW="150px" p="3" bg="bg.panel" borderRadius="l2"><Text fontSize="12px" color="fg.subtle">Opened</Text><Text fontSize="14px" fontVariantNumeric="tabular-nums" mt="0.5">{activeRound.guests[0] ? formatDateTime(activeRound.guests[0].firstSeenAt) : "Not yet"}</Text></Stack>
                  <Stack gap="0" flex="1" minW="150px" p="3" bg="bg.panel" borderRadius="l2"><Text fontSize="12px" color="fg.subtle">Decision</Text><Text fontSize="14px" mt="0.5">{eventLabel(activeRound.decision ?? "pending")}</Text></Stack>
                  <Stack gap="0" flex="1" minW="150px" p="3" bg="bg.panel" borderRadius="l2"><Text fontSize="12px" color="fg.subtle">Expires</Text><Text fontSize="14px" fontVariantNumeric="tabular-nums" mt="0.5">{activeRound.expiresAt ? formatDateTime(activeRound.expiresAt) : "No expiry"}</Text></Stack>
                </Flex>
              </Stack>

              <Stack gap="2">
                {activeRound.items.map((item, index) => (
                  <Flex key={item.id} px="4" py="3" bg="bg.subtle" borderRadius="l2" align="center" justify="space-between" gap="3">
                    <Flex align="center" gap="3" minW="0">
                      <ClipTile index={index} />
                      <Box minW="0">
                        <Flex align="center" gap="2"><Text fontSize="sm" fontWeight="550" truncate>{item.clipTitle}</Text>{item.required ? null : <Text fontSize="11px" color="fg.muted" bg="bg.soft" px="1.5" py="0.5" borderRadius="full">Optional</Text>}</Flex>
                        <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle" mt="0.5">{["Revision " + item.editorRevision, ...item.variants.map((variant) => aspectLabel(variant.aspectRatio))].join(" · ")}</Text>
                      </Box>
                    </Flex>
                    <StatusBadge label={eventLabel(item.currentDecision ?? "awaiting decision")} status={item.currentDecision === "approved" ? "completed" : "pending"} />
                  </Flex>
                ))}
              </Stack>

              {activeRound.context.length > 0 ? (
                <Stack gap="2">
                  <Flex align="center" justify="space-between" gap="3"><Text textStyle="eyebrow" color="fg.muted">Open feedback from earlier rounds</Text><Text fontSize="12px" color="fg.subtle">Internal only</Text></Flex>
                  {activeRound.context.map((context) => (
                    <Flex key={context.id} gap="3" p="4" bg="bg.subtle" borderRadius="l3">
                      <Initials name={context.authorName} guest />
                      <Box minW="0">
                        <Flex gap="2" wrap="wrap" align="center"><Text fontSize="13px" fontWeight="600">{context.authorName}</Text><Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">Round {String(context.sourceRoundRevision).padStart(2, "0")}</Text>{context.clipTitle ? <Text fontSize="12px" color="fg.subtle">{context.clipTitle}</Text> : null}{context.timestampSec !== null ? <Text textStyle="data" fontSize="12px" color="accent.fg" bg="accent.muted" px="1.5" py="0.5" borderRadius="full">{formatTimecode(context.timestampSec)}</Text> : null}</Flex>
                        <Text fontSize="13px" color="fg.muted" mt="1" whiteSpace="pre-wrap">{context.body}</Text>
                      </Box>
                    </Flex>
                  ))}
                </Stack>
              ) : null}

              <Flex direction={{ base: "column", xl: "row" }} gap="6" align="start">
                <Stack flex="1" w="full" minW="0" gap="3">
                  <Flex align="center" justify="space-between"><Flex align="center" gap="2" color="fg.muted"><MessageSquareText size={16} /><Text textStyle="eyebrow">Feedback</Text></Flex><Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">{activeRound.comments.filter((comment) => !comment.parentId).length} threads</Text></Flex>
                  {activeRound.comments.filter((comment) => !comment.parentId).map((thread) => {
                    const replies = activeRound.comments.filter((comment) => comment.parentId === thread.id);
                    const fromGuest = thread.authorKind === "guest";
                    return (
                      <Stack key={thread.id} gap="3" p="4" bg="bg.subtle" borderRadius="l3">
                        <Flex justify="space-between" gap="3" align="start">
                          <Flex gap="3" minW="0">
                            <Initials name={thread.authorName} guest={fromGuest} />
                            <Box minW="0">
                              <Flex align="center" gap="2" wrap="wrap"><Text fontSize="13px" fontWeight="600">{thread.authorName}</Text><Text fontSize="12px" color="fg.subtle">{fromGuest ? "Client" : "Team"}</Text>{thread.timestampSec !== null ? <Text textStyle="data" color="accent.fg" fontSize="12px" bg="accent.muted" px="1.5" py="0.5" borderRadius="full">{formatTimecode(thread.timestampSec)}</Text> : null}</Flex>
                              <Text fontSize="13px" color="fg.muted" mt="1" whiteSpace="pre-wrap">{thread.body}</Text>
                            </Box>
                          </Flex>
                          <StatusBadge label={thread.resolvedAt ? "resolved" : "open"} status={thread.resolvedAt ? "completed" : "pending"} />
                        </Flex>
                        {replies.map((reply) => <Box key={reply.id} ms="11" p="3" bg="bg.panel" borderRadius="l2"><Text fontSize="12px" fontWeight="600">{reply.authorName}</Text><Text fontSize="13px" color="fg.muted" mt="0.5" whiteSpace="pre-wrap">{reply.body}</Text></Box>)}
                        {canManage ? <Flex gap="2" ms="9"><Button size="sm" variant="ghost" onClick={() => { setReplyParentId(thread.id); setReplyBody(""); requestAnimationFrame(() => replyRef.current?.focus()); }}>Reply</Button><Button size="sm" variant="ghost" onClick={() => void mutate({ kind: thread.resolvedAt ? "reopen" : "resolve", roundId: activeRound.id, commentId: thread.id })} disabled={busy}>{thread.resolvedAt ? <RotateCcw size={12} /> : <Check size={12} />}{thread.resolvedAt ? "Reopen" : "Resolve"}</Button></Flex> : null}
                      </Stack>
                    );
                  })}
                  {canManage ? <Stack gap="2" p="4" bg="bg.subtle" borderRadius="l3"><Text fontSize="12px" fontWeight="650">{replyParentId ? "Reply to thread" : "Add team note"}</Text><Textarea ref={replyRef} rows={3} value={replyBody} onChange={(event) => setReplyBody(event.target.value.slice(0, 2000))} placeholder={activeRound.recipientEmails.length > 0 ? `Mention a recipient with @${activeRound.recipientEmails[0]}` : "Write a clear response"} /><Flex justify="space-between" gap="2"><Button size="sm" variant="ghost" disabled={!replyParentId} onClick={() => { setReplyParentId(null); setReplyBody(""); }}>Cancel reply</Button><Button size="sm" variant="subtle" disabled={!replyBody.trim() || busy} onClick={() => void submitReply(activeRound)}><Send size={13} /> Add reply</Button></Flex></Stack> : null}
                </Stack>

                <Stack w={{ base: "full", xl: "310px" }} flexShrink={0} gap="3">
                  <SideCard icon={<UserRound size={15} />} title="Reviewers">
                    {activeRound.guests.length === 0 ? <Text fontSize="13px" color="fg.muted">No one has opened the review room yet.</Text> : canManage ? activeRound.guests.map((guest) => (
                      <Flex key={guest.id} gap="3" align="center" minW="0">
                        <Initials name={guest.displayName ?? guest.email ?? ""} guest />
                        <Box minW="0">
                          <Text fontSize="13px" fontWeight="600" truncate>{guest.displayName ?? guest.email ?? "Reviewer"}</Text>
                          {guest.displayName && guest.email ? <Text fontSize="12px" color="fg.subtle" truncate>{guest.email}</Text> : null}
                          <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">Last seen {formatDateTime(guest.lastSeenAt)}</Text>
                        </Box>
                      </Flex>
                    )) : <Text fontSize="13px" color="fg.muted">{activeRound.guests.length} reviewer{activeRound.guests.length === 1 ? " has" : "s have"} opened the room.</Text>}
                  </SideCard>
                  {canManage ? (
                    <SideCard icon={<Send size={15} />} title="Delivery">
                      {activeRound.recipientEmails.length > 0 ? <Flex gap="1.5" wrap="wrap">{activeRound.recipientEmails.map((email) => <Text key={email} fontSize="12px" bg="bg.soft" px="2" py="1" borderRadius="full" maxW="full" truncate>{email}</Text>)}</Flex> : <Text fontSize="13px" color="fg.muted">No one was emailed for this round.</Text>}
                      {activeRound.recipientEmails.length > 0 && activeRound.notifications.length === 0 ? <Text fontSize="12px" color="fg.subtle">Emails were paused when this round went out.</Text> : activeRound.notifications.map((notification) => (
                        <Flex key={notification.id} justify="space-between" gap="2" align="center">
                          <Box minW="0">
                            <Text fontSize="12px" truncate>{notification.recipientEmail}</Text>
                            <Text fontSize="12px" color="fg.subtle">{eventLabel(notification.kind)}</Text>
                            {notification.failureCode ? <Text fontSize="12px" color="danger.fg">{eventLabel(notification.failureCode)}</Text> : null}
                          </Box>
                          <Flex align="center" gap="1" flexShrink={0}>
                            <StatusBadge label={notification.status} status={notification.status === "failed" ? "failed" : notification.status === "sent" ? "completed" : "pending"} />
                            {notification.status === "failed" ? <Button size="sm" variant="ghost" onClick={() => void mutate({ kind: "retry", roundId: activeRound.id, ledgerId: notification.id })} disabled={busy}><RefreshCw size={12} /> Retry</Button> : null}
                          </Flex>
                        </Flex>
                      ))}
                    </SideCard>
                  ) : null}
                  {canManage ? (
                    <SideCard icon={<Clock3 size={15} />} title="Audit history">
                      <Stack gap="2">{activeRound.auditEvents.slice(0, 12).map((event) => <Flex key={event.id} justify="space-between" gap="3"><Text fontSize="12px">{eventLabel(event.kind)}</Text><Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">{formatDateTime(event.createdAt)}</Text></Flex>)}</Stack>
                    </SideCard>
                  ) : null}
                </Stack>
              </Flex>

              {canManage ? <Flex justify="space-between" gap="3" wrap="wrap"><Button variant="subtle" onClick={() => prepareNext(activeRound)}><RefreshCw size={14} /> Prepare next round</Button>{!activeRound.revokedAt ? <Button variant="ghost" colorPalette="danger" onClick={() => void mutate({ kind: "revoke", roundId: activeRound.id })} disabled={busy}><ShieldCheck size={14} /> Revoke access</Button> : null}</Flex> : null}
            </Stack>
          ) : null}
        </Flex>
      ) : null}
    </Stack>
  );
}
