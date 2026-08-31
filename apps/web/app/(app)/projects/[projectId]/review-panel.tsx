"use client";

import {
  Box,
  Flex,
  Grid,
  Heading,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Progress } from "@narriflow/ui/components/progress";
import { reviewRoundCreateResponseSchema } from "@narriflow/validators";
import {
  AlertTriangle,
  Check,
  Copy,
  MessageSquareText,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDate, formatDateTime, formatDuration, formatTimecode } from "@/lib/format";
import { authenticatedRequestFailureMessage } from "@/lib/authenticated-request-browser";
import { restoreCampaignReviewSelection } from "./campaign-selection";
import { ReviewAuditHistory } from "./review-audit-history";
import { createReviewBrowserIntents } from "./review-browser-intents";
import type { ReviewCreationAccess } from "./review-creation-access";

type ReviewCandidate = {
  id: string;
  clipId: string;
  editorRevision: number;
  createdAt: string;
  clip: {
    title: string | null;
    index: number;
    startSec: number;
    endSec: number;
    editorRevision: number;
  };
  variants: Array<{
    id: string;
    aspectRatio: string;
    resolution: string;
    durationSec: number | null;
    status: string;
  }>;
};

type ReviewRound = {
  id: string;
  revision: number;
  status: string;
  responsesOpen: boolean;
  title: string;
  message: string | null;
  sentAt: string;
  expiresAt: string | null;
  allowDownloads: boolean;
  approvalRequired: boolean;
  decision: string | null;
  newerWorkAvailable: boolean;
  items: Array<{
    id: string;
    clipId: string;
    exportId: string;
    required: boolean;
    currentDecision: string | null;
    selectedVariantIds: unknown;
    newerWorkAvailable: boolean;
    clip: { title: string | null; index: number };
  }>;
  recipients: Array<{
    id: string;
    role: string;
    email: string | null;
    createdAt: string;
  }>;
  notifications: Array<{
    id: string;
    recipientId: string;
    kind: string;
    status: string;
    attemptCount: number;
    nextAttemptAt: string;
    failureCode: string | null;
    sentAt: string | null;
    createdAt: string;
    retryOfNotificationId: string | null;
  }>;
  comments: Array<{
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
  }>;
  auditEvents: Array<{
    id: string;
    kind: string;
    targetId: string | null;
    createdAt: string;
  }>;
};

type ReviewWorkspace = {
  project: { id: string; title: string; approvalRequired: boolean };
  candidates: ReviewCandidate[];
  rounds: ReviewRound[];
};

const REVIEW_CREATION_DENIAL_COPY = {
  capability_denied: {
    eyebrow: "View-only access",
    title: "Review desk is view-only",
    description:
      "Existing rounds, comments, delivery state, and audit history remain available. Review changes require workspace review access.",
  },
  plan_required: {
    eyebrow: "Business plan",
    title: "New review rounds require the Business plan",
    description:
      "Existing rounds, comments, and guest access stay available. Creating and resubmitting rounds is locked on this plan.",
  },
  rollout_paused: {
    eyebrow: "Rollout paused",
    title: "New review rounds are temporarily unavailable",
    description:
      "An administrator has paused new review rounds during rollout. Existing rounds, comments, and guest access stay available.",
  },
} satisfies Record<
  Exclude<ReviewCreationAccess, "available">,
  { eyebrow: string; title: string; description: string }
>;

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function ratioLabel(value: string) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

export function reviewCandidateDurationSec(candidate: {
  clip: { startSec: number; endSec: number };
  variants: ReadonlyArray<{ status: string; durationSec: number | null }>;
}) {
  const completedDurations = candidate.variants.flatMap((variant) =>
    variant.status === "completed" &&
    variant.durationSec !== null &&
    Number.isFinite(variant.durationSec) &&
    variant.durationSec > 0
      ? [variant.durationSec]
      : [],
  );
  return completedDurations.length > 0
    ? Math.max(...completedDurations)
    : Math.max(0, candidate.clip.endSec - candidate.clip.startSec);
}

function failureMessage(payload: unknown, fallback: string) {
  return authenticatedRequestFailureMessage(
    payload && typeof payload === "object" ? payload : {},
    typeof window === "undefined"
      ? "/home"
      : `${window.location.pathname}${window.location.search}`,
    fallback,
  );
}

export function ReviewCreationGate({
  creationAccess,
  children,
}: {
  creationAccess: ReviewCreationAccess;
  children: ReactNode;
}) {
  if (creationAccess === "available") return <>{children}</>;
  const copy = REVIEW_CREATION_DENIAL_COPY[creationAccess];

  return (
    <Flex
      role="note"
      aria-label="Review creation locked"
      align={{ base: "start", md: "center" }}
      gap="3"
      px="4"
      py="4"
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      bg="bg.subtle"
    >
      <Box color="accent.fg" pt={{ base: "0.5", md: "0" }}>
        <ShieldCheck size={18} aria-hidden />
      </Box>
      <Box>
        <Text textStyle="eyebrow" color="accent.fg">
          {copy.eyebrow}
        </Text>
        <Heading as="h3" mt="1" fontSize="15px" lineHeight="1.3">
          {copy.title}
        </Heading>
        <Text mt="1" maxW="68ch" color="fg.muted" fontSize="12px">
          {copy.description}
        </Text>
      </Box>
    </Flex>
  );
}

export function isReviewResubmissionAvailable(
  canCreateReview: boolean,
  round: Pick<ReviewRound, "id" | "newerWorkAvailable">,
  latestRoundId: string | undefined,
) {
  return canCreateReview && round.newerWorkAvailable && round.id === latestRoundId;
}

export function ReviewPanel({
  projectId,
  availableClipIds,
  creationAccess,
  canManageReview,
}: {
  projectId: string;
  availableClipIds: string[];
  creationAccess: ReviewCreationAccess;
  canManageReview: boolean;
}) {
  const canCreateReview = creationAccess === "available";
  const endpoint = `/api/projects/${projectId}/review-rounds`;
  const [data, setData] = useState<ReviewWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [recipients, setRecipients] = useState("");
  const [passcode, setPasscode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [selectedExports, setSelectedExports] = useState<Set<string>>(new Set());
  const [selectedVariants, setSelectedVariants] = useState<Map<string, Set<string>>>(new Map());
  const [sourceRoundId, setSourceRoundId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [discussionRoundId, setDiscussionRoundId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [mentionRecipientIds, setMentionRecipientIds] = useState<Set<string>>(new Set());
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const approvalDefaultInitializedRef = useRef(false);
  const campaignSelectionInitializedProjectRef = useRef<string | null>(null);
  const browserIntentsRef = useRef<ReturnType<
    typeof createReviewBrowserIntents
  > | null>(null);

  function browserIntents() {
    browserIntentsRef.current ??= createReviewBrowserIntents({
      storage: window.sessionStorage,
      createId: () => crypto.randomUUID(),
    });
    return browserIntentsRef.current;
  }

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) throw new Error(failureMessage(payload, "Review rounds could not be loaded."));
    const workspace = payload as ReviewWorkspace;
    setData(workspace);
    if (campaignSelectionInitializedProjectRef.current !== projectId) {
      const restored = restoreCampaignReviewSelection(
        window.sessionStorage,
        projectId,
        availableClipIds,
        workspace.candidates,
      );
      campaignSelectionInitializedProjectRef.current = projectId;
      setSelectedExports(restored.exportIds);
      setSelectedVariants(restored.variantIdsByExport);
    }
    setTitle((current) => current || `${workspace.project.title} — client review`);
    if (!approvalDefaultInitializedRef.current) {
      approvalDefaultInitializedRef.current = true;
      setApprovalRequired(workspace.project.approvalRequired);
    }
    setDiscussionRoundId((current) => current ?? workspace.rounds[0]?.id ?? null);
  }, [availableClipIds, endpoint, projectId]);

  useEffect(() => {
    let active = true;
    void load()
      .catch((error) => {
        if (active) {
          setNotice({
            tone: "danger",
            text: error instanceof Error ? error.message : "Review rounds could not be loaded.",
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const activeRound =
    data?.rounds.find((round) => round.id === discussionRoundId) ??
    data?.rounds[0] ??
    null;

  const recipientEmails = useMemo(
    () =>
      [...new Set(
        recipients
          .split(/[\s,;]+/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      )],
    [recipients],
  );

  async function request(
    path: string,
    body?: unknown,
    success = "Review updated.",
    intent?: { idempotencyKey: string; confirm(): void },
  ) {
    if (!canManageReview) {
      setNotice({
        tone: "danger",
        text: "Review changes require workspace review access.",
      });
      return null;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers:
          body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) throw new Error(failureMessage(payload, "Review could not be updated."));
      try {
        await load();
        intent?.confirm();
        setNotice({ tone: "success", text: success });
      } catch {
        setNotice({
          tone: "danger",
          text: `${success} Refresh the page to load the latest review status.`,
        });
      }
      requestAnimationFrame(() => noticeRef.current?.focus());
      return payload as Record<string, unknown>;
    } catch (error) {
      setNotice({
        tone: "danger",
        text: error instanceof Error ? error.message : "Review could not be updated.",
      });
      requestAnimationFrame(() => noticeRef.current?.focus());
      return null;
    } finally {
      setBusy(false);
    }
  }

  function toggleCandidate(candidate: ReviewCandidate, checked: boolean) {
    setSelectedExports((current) => {
      const next = new Set(current);
      if (checked) next.add(candidate.id);
      else next.delete(candidate.id);
      return next;
    });
    setSelectedVariants((current) => {
      const next = new Map(current);
      if (checked) next.set(candidate.id, new Set(candidate.variants.map((variant) => variant.id)));
      else next.delete(candidate.id);
      return next;
    });
  }

  function toggleVariant(exportId: string, variantId: string, checked: boolean) {
    setSelectedVariants((current) => {
      const next = new Map(current);
      const variants = new Set(next.get(exportId) ?? []);
      if (checked) variants.add(variantId);
      else variants.delete(variantId);
      next.set(exportId, variants);
      return next;
    });
  }

  async function sendRound() {
    if (!canManageReview || !canCreateReview) {
      setNotice({
        tone: "danger",
        text: "New review rounds require the Business plan.",
      });
      return;
    }
    if (!data || selectedExports.size === 0) {
      setNotice({ tone: "danger", text: "Choose at least one ready export." });
      return;
    }
    if (recipientEmails.length === 0) {
      setNotice({ tone: "danger", text: "Add at least one reviewer email." });
      return;
    }
    const items = data.candidates
      .filter((candidate) => selectedExports.has(candidate.id))
      .map((candidate) => ({
        clipId: candidate.clipId,
        exportId: candidate.id,
        expectedEditorRevision: candidate.editorRevision,
        variantIds: [...(selectedVariants.get(candidate.id) ?? new Set())],
        required: true,
      }));
    if (items.some((item) => item.variantIds.length === 0)) {
      setNotice({ tone: "danger", text: "Choose at least one format for every selected clip." });
      return;
    }
    const requestBody = {
      title,
      message: message.trim() || null,
      passcode: passcode || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      allowDownloads,
      approvalRequired,
      recipientEmails,
      sourceRoundId,
      items,
    };
    const intent = browserIntents().createRound(projectId, requestBody);
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
      const rawPayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          failureMessage(rawPayload, "Review round could not be sent."),
        );
      }
      const parsed = reviewRoundCreateResponseSchema.safeParse(rawPayload);
      if (!parsed.success || parsed.data.id !== intent.idempotencyKey) {
        throw new Error(
          "Review creation response was incomplete. Retry to reconcile the same request.",
        );
      }
      const payload = parsed.data;
      intent.confirm();
      setShareUrl(new URL(payload.path, window.location.origin).toString());
      setSourceRoundId(null);
      setSelectedExports(new Set());
      setSelectedVariants(new Map());
      const deliveryPending = payload.delivery.some(
        (entry) => entry.status !== "sent",
      );
      try {
        await load();
        setNotice({
          tone: deliveryPending ? "danger" : "success",
          text: deliveryPending
            ? "Round created. One or more emails are queued for retry."
            : "Review round sent.",
        });
      } catch {
        setNotice({
          tone: "danger",
          text: "Review round sent. Refresh the page to load the latest status.",
        });
      }
    } catch (error) {
      setNotice({
        tone: "danger",
        text: error instanceof Error ? error.message : "Review round could not be sent.",
      });
    } finally {
      setBusy(false);
      requestAnimationFrame(() => noticeRef.current?.focus());
    }
  }

  async function addComment() {
    if (!canManageReview || !activeRound || !comment.trim()) return;
    const parent = replyToId
      ? activeRound.comments.find((entry) => entry.id === replyToId)
      : null;
    const result = await request(
      `/${activeRound.id}/comments`,
      {
        itemId: parent?.itemId ?? null,
        parentId: parent?.id ?? null,
        body: comment,
        timestampSec: null,
        mentionRecipientIds: [...mentionRecipientIds],
      },
      "Comment posted.",
    );
    if (result) {
      setComment("");
      setReplyToId(null);
      setMentionRecipientIds(new Set());
    }
  }

  if (loading) {
    return <Text textStyle="eyebrow" color="fg.muted">Loading review desk…</Text>;
  }

  if (!data) {
    return <EmptyState title="Review desk unavailable" description={notice?.text ?? "The review workspace could not be loaded."} />;
  }

  return (
    <Stack gap="8">
      <Flex justify="space-between" align={{ base: "start", md: "end" }} gap="4" direction={{ base: "column", md: "row" }}>
        <Box>
          <Text textStyle="eyebrow" color="accent.fg">Client delivery</Text>
          <Heading textStyle="title" mt="1">Review desk</Heading>
          <Text mt="1" color="fg.muted" fontSize="13px">
            Freeze exact exports, collect accountable feedback, and keep delivery state visible.
          </Text>
        </Box>
        <Flex align="center" gap="2" color={data.project.approvalRequired ? "accent.fg" : "fg.muted"}>
          <ShieldCheck size={16} aria-hidden />
          <Text textStyle="eyebrow">
            {data.project.approvalRequired ? "Approval required to publish" : "Approval advisory"}
          </Text>
        </Flex>
      </Flex>

      <Box layerStyle="band" borderTopWidth="3px" borderColor="accent.solid">
        <Stack gap="5">
          <Flex justify="space-between" align="center" gap="3">
            <Box>
              <Text textStyle="eyebrow">Prepare a round</Text>
              <Text mt="1" fontSize="12px" color="fg.muted">
                Each selection points to an immutable Clip Export and its chosen formats.
              </Text>
            </Box>
            {canCreateReview && sourceRoundId ? (
              <Button size="xs" variant="ghost" onClick={() => setSourceRoundId(null)}>
                <X size={12} aria-hidden /> Cancel resubmission
              </Button>
            ) : null}
          </Flex>

          <ReviewCreationGate
            creationAccess={creationAccess}
          >
            {data.candidates.length === 0 ? (
              <EmptyState title="No review-ready exports" description="Render at least one clip before creating a client round." />
            ) : (
              <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
                {data.candidates.map((candidate) => {
                  const checked = selectedExports.has(candidate.id);
                  return (
                    <Box key={candidate.id} py="3" borderBottomWidth="1px" borderColor="border.subtle">
                      <Flex align="start" justify="space-between" gap="4" direction={{ base: "column", md: "row" }}>
                        <Checkbox checked={checked} onCheckedChange={(value) => toggleCandidate(candidate, value)}>
                          <Stack gap="0">
                            <Text fontWeight="600">{candidate.clip.title || `Clip ${candidate.clip.index + 1}`}</Text>
                            <Text fontSize="11px" color="fg.subtle">
                              Revision {candidate.editorRevision} · {formatDuration(reviewCandidateDurationSec(candidate))} · exported {formatDate(candidate.createdAt)}
                            </Text>
                          </Stack>
                        </Checkbox>
                        <Flex gap="3" wrap="wrap" ps={{ base: "6", md: "0" }}>
                          {candidate.variants.map((variant) => (
                            <Checkbox
                              key={variant.id}
                              checked={selectedVariants.get(candidate.id)?.has(variant.id) ?? false}
                              disabled={!checked}
                              onCheckedChange={(value) => toggleVariant(candidate.id, variant.id, value)}
                            >
                              {ratioLabel(variant.aspectRatio)} · {variant.resolution}
                            </Checkbox>
                          ))}
                        </Flex>
                      </Flex>
                    </Box>
                  );
                })}
              </Stack>
            )}

            <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }} gap="4">
              <Stack gap="1.5">
                <Text textStyle="eyebrow" color="fg.subtle">Round title</Text>
                <Input value={title} onChange={(event) => setTitle(event.target.value.slice(0, 160))} maxLength={160} />
              </Stack>
              <Stack gap="1.5">
                <Text textStyle="eyebrow" color="fg.subtle">Reviewer emails</Text>
                <Input value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="client@example.com, producer@example.com" />
              </Stack>
              <Stack gap="1.5">
                <Text textStyle="eyebrow" color="fg.subtle">Optional passcode</Text>
                <Input type="password" value={passcode} onChange={(event) => setPasscode(event.target.value.slice(0, 128))} minLength={6} maxLength={128} />
              </Stack>
              <Stack gap="1.5">
                <Text textStyle="eyebrow" color="fg.subtle">Expires</Text>
                <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
              </Stack>
            </Grid>
            <Stack gap="1.5">
              <Text textStyle="eyebrow" color="fg.subtle">Message</Text>
              <Textarea value={message} onChange={(event) => setMessage(event.target.value.slice(0, 2000))} maxLength={2000} rows={3} placeholder="What should the client focus on in this round?" />
            </Stack>
            <Flex gap="5" wrap="wrap">
              <Checkbox checked={allowDownloads} onCheckedChange={setAllowDownloads}>Allow downloads</Checkbox>
              <Checkbox checked={approvalRequired} onCheckedChange={setApprovalRequired}>Require campaign approval</Checkbox>
            </Flex>
            <Flex justify="flex-end">
              <Button disabled={busy || !title.trim() || selectedExports.size === 0} onClick={() => void sendRound()}>
                <Send size={14} aria-hidden /> {busy ? "Sending…" : sourceRoundId ? "Send next round" : "Send review"}
              </Button>
            </Flex>
            {shareUrl ? (
              <Flex align="center" gap="2" borderTopWidth="1px" borderColor="border.subtle" pt="3">
                <Text fontSize="12px" color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{shareUrl}</Text>
                <Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(shareUrl)}>
                  <Copy size={12} aria-hidden /> Copy link
                </Button>
              </Flex>
            ) : null}
          </ReviewCreationGate>
        </Stack>
      </Box>

      <Box ref={noticeRef} tabIndex={-1} aria-live="polite">
        {notice ? (
          <Flex align="center" gap="2" color={notice.tone === "success" ? "success.fg" : "danger.fg"}>
            {notice.tone === "success" ? <Check size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
            <Text fontSize="13px">{notice.text}</Text>
          </Flex>
        ) : null}
      </Box>

      <Stack gap="4">
        <Text textStyle="eyebrow" color="fg.subtle">Round history</Text>
        {data.rounds.length === 0 ? (
          <EmptyState title="No review rounds yet" description="The first round will appear here with comments, decisions, and delivery attempts." />
        ) : data.rounds.map((round) => {
          const required = round.items.filter((item) => item.required);
          const approved = required.filter((item) => item.currentDecision === "approved").length;
          const supersededNotificationIds = new Set(
            round.notifications.flatMap((entry) =>
              entry.retryOfNotificationId ? [entry.retryOfNotificationId] : [],
            ),
          );
          const failedNotifications = round.notifications.filter(
            (entry) =>
              !supersededNotificationIds.has(entry.id) &&
              (entry.status === "failed" || entry.failureCode),
          );
          return (
            <Box key={round.id} as="section" borderTopWidth="3px" borderColor={round.status === "open" ? "accent.solid" : "border.emphasized"} pt="4">
              <Flex justify="space-between" align={{ base: "start", md: "center" }} gap="4" direction={{ base: "column", md: "row" }}>
                <Box>
                  <Flex align="center" gap="2" wrap="wrap">
                    <Heading textStyle="title" fontSize="18px">Round {round.revision} · {round.title}</Heading>
                    {round.newerWorkAvailable ? <Text textStyle="eyebrow" color="warning.fg">Newer work available</Text> : null}
                  </Flex>
                  <Text mt="1" fontSize="12px" color="fg.muted">
                    {statusLabel(round.status)} · sent {formatDateTime(round.sentAt)} · {round.recipients.filter((entry) => entry.role === "reviewer").length} reviewers
                  </Text>
                </Box>
                <Flex gap="2" wrap="wrap">
                  {canManageReview && round.responsesOpen ? (
                    <>
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => {
                        const intent = browserIntents().resendRound(projectId, round.id);
                        void request(
                          `/${round.id}/resend`,
                          { idempotencyKey: intent.idempotencyKey },
                          "Review link resent.",
                          intent,
                        );
                      }}>
                        <RefreshCw size={12} aria-hidden /> Resend
                      </Button>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void request(`/${round.id}/revoke`, undefined, "Review round revoked.")}>
                        Revoke
                      </Button>
                    </>
                  ) : null}
                  {isReviewResubmissionAvailable(
                    canManageReview && canCreateReview,
                    round,
                    data.rounds[0]?.id,
                  ) ? (
                    <Button size="xs" variant="outline" onClick={() => {
                      setSourceRoundId(round.id);
                      setTitle(`${data.project.title} — round ${round.revision + 1}`);
                      setMessage(round.message ?? "");
                      setRecipients(round.recipients.filter((entry) => entry.role === "reviewer").map((entry) => entry.email).filter(Boolean).join(", "));
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}>
                      Prepare next round
                    </Button>
                  ) : null}
                </Flex>
              </Flex>

              <Flex mt="3" align="center" gap="3">
                <Box flex="1"><Progress value={required.length ? (approved / required.length) * 100 : 100} /></Box>
                <Text textStyle="data" fontSize="11px" color="fg.timecode">{approved}/{required.length} approved</Text>
              </Flex>

              {failedNotifications.length > 0 ? (
                <Stack mt="4" gap="0" borderTopWidth="1px" borderColor="border.subtle">
                  {failedNotifications.map((notification) => {
                    const recipient = round.recipients.find((entry) => entry.id === notification.recipientId);
                    return (
                      <Flex key={notification.id} py="2.5" justify="space-between" gap="3" align="center" borderBottomWidth="1px" borderColor="border.subtle">
                        <Box>
                          <Text fontSize="12px">{recipient?.email ?? "Reviewer"} · {statusLabel(notification.kind)}</Text>
                          <Text textStyle="data" fontSize="10px" color="danger.fg">{notification.failureCode ?? "Delivery pending"} · attempt {notification.attemptCount}</Text>
                        </Box>
                        {canManageReview && notification.status === "failed" ? (
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => {
                            const intent = browserIntents().retryNotification(
                              projectId,
                              round.id,
                              notification.id,
                            );
                            void request(
                              `/${round.id}/notifications/${notification.id}/retry`,
                              { idempotencyKey: intent.idempotencyKey },
                              "Delivery retried.",
                              intent,
                            );
                          }}>
                            Retry
                          </Button>
                        ) : null}
                      </Flex>
                    );
                  })}
                </Stack>
              ) : null}

              <Button mt="3" size="xs" variant={discussionRoundId === round.id ? "outline" : "ghost"} onClick={() => setDiscussionRoundId(round.id)}>
                <MessageSquareText size={12} aria-hidden /> {round.comments.length} comments
              </Button>
              <Box mt="4">
                <ReviewAuditHistory events={round.auditEvents} />
              </Box>
            </Box>
          );
        })}
      </Stack>

      {activeRound ? (
        <Box borderTopWidth="1px" borderColor="border.subtle" pt="5">
          <Flex align="center" justify="space-between" gap="3">
            <Box>
              <Text textStyle="eyebrow">Discussion · round {activeRound.revision}</Text>
              <Text mt="1" fontSize="12px" color="fg.muted">Internal replies are visible in the guest room. Notifications are sent only for explicit mentions.</Text>
            </Box>
          </Flex>
          <Grid mt="4" templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 340px" }} gap="6">
            <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
              {activeRound.comments.length === 0 ? (
                <Text py="4" color="fg.muted" fontSize="13px">No comments yet.</Text>
              ) : activeRound.comments.map((entry) => (
                <Box key={entry.id} py="3" ps={entry.parentId ? "5" : "0"} borderBottomWidth="1px" borderColor="border.subtle" opacity={entry.resolvedAt ? 0.6 : 1}>
                  <Flex justify="space-between" gap="3" align="start">
                    <Box>
                      <Text fontSize="12px" fontWeight="600">{entry.authorName}{entry.authorKind === "internal" ? " · team" : " · reviewer"}</Text>
                      <Text mt="1" fontSize="13px" color="fg.muted" whiteSpace="pre-wrap">{entry.body}</Text>
                      {entry.timestampSec !== null ? <Text mt="1" textStyle="data" fontSize="10px" color="fg.timecode">{formatTimecode(entry.timestampSec)}</Text> : null}
                    </Box>
                    {canManageReview ? (
                      <Flex gap="1">
                        {!entry.parentId && activeRound.responsesOpen ? <Button size="xs" variant="ghost" onClick={() => setReplyToId(entry.id)}>Reply</Button> : null}
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void request(`/${activeRound.id}/comments/${entry.id}/${entry.resolvedAt ? "reopen" : "resolve"}`, undefined, entry.resolvedAt ? "Comment reopened." : "Comment resolved.")}>
                          {entry.resolvedAt ? "Reopen" : "Resolve"}
                        </Button>
                      </Flex>
                    ) : null}
                  </Flex>
                </Box>
              ))}
            </Stack>
            {canManageReview ? <Stack gap="3">
              {replyToId ? <Text fontSize="12px" color="fg.muted">Replying in thread. <Button size="xs" variant="ghost" onClick={() => setReplyToId(null)}>Cancel</Button></Text> : null}
              <Textarea value={comment} onChange={(event) => setComment(event.target.value.slice(0, 2000))} maxLength={2000} rows={4} placeholder="Add production context or reply to feedback" disabled={!activeRound.responsesOpen} />
              {activeRound.recipients.length > 0 ? (
                <Stack gap="1">
                  <Text textStyle="eyebrow" color="fg.subtle">Notify explicitly</Text>
                  {activeRound.recipients.map((recipient) => (
                    <Checkbox key={recipient.id} checked={mentionRecipientIds.has(recipient.id)} onCheckedChange={(checked) => setMentionRecipientIds((current) => {
                      const next = new Set(current);
                      if (checked) next.add(recipient.id);
                      else next.delete(recipient.id);
                      return next;
                    })}>
                      {recipient.email ?? statusLabel(recipient.role)}
                    </Checkbox>
                  ))}
                </Stack>
              ) : null}
              <Button variant="outline" disabled={busy || !comment.trim() || !activeRound.responsesOpen} onClick={() => void addComment()}>
                Post comment
              </Button>
            </Stack> : (
              <Flex
                role="note"
                align="start"
                gap="2"
                borderTopWidth="1px"
                borderColor="border.subtle"
                pt="3"
                color="fg.muted"
              >
                <ShieldCheck size={14} aria-hidden />
                <Text fontSize="12px">
                  Discussion is readable. Posting or resolving feedback requires
                  workspace review access.
                </Text>
              </Flex>
            )}
          </Grid>
        </Box>
      ) : null}
    </Stack>
  );
}
