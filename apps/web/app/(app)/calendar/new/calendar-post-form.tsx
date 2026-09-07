"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { chakra, Flex, Stack, Text } from "@chakra-ui/react";
import type { ClipAspectRatio, SocialPlatform } from "@prisma/client";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Combobox } from "@narriflow/ui/components/combobox";
import { DateTimePicker } from "@narriflow/ui/components/date-picker";
import { Select } from "@narriflow/ui/components/select";
import { createPublicationIntentKeyStore } from "@/lib/publication-intent-key";
import { scheduleWorkspacePostAction } from "../actions";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";
import {
  ReviewApprovalCheckpoint,
  reviewApprovalOverrideReady,
  reviewOverrideReasonForRequest,
} from "../../_components/review-approval-checkpoint";

type ClipOption = {
  id: string;
  editorRevision: number;
  projectId: string;
  title: string;
  projectTitle: string;
  aspectRatios: ClipAspectRatio[];
};

type AccountOption = {
  id: string;
  platform: SocialPlatform;
  displayName: string;
  handle: string | null;
};

const ratioMap: Record<ClipAspectRatio, "9:16" | "1:1" | "16:9" | "4:5"> = {
  ratio_9_16: "9:16",
  ratio_1_1: "1:1",
  ratio_16_9: "16:9",
  ratio_4_5: "4:5",
};

export function CalendarPostForm({
  clips,
  accounts,
  timezone,
  canOverrideReview,
}: {
  clips: ClipOption[];
  accounts: AccountOption[];
  timezone: string;
  canOverrideReview: boolean;
}) {
  const router = useRouter();
  const [clipId, setClipId] = useState(clips[0]?.id ?? "");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [caption, setCaption] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [ratio, setRatio] = useState<ClipAspectRatio>(clips[0]?.aspectRatios[0] ?? "ratio_9_16");
  const [resolution, setResolution] = useState<"720p" | "1080p">("1080p");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approvalBlocked, setApprovalBlocked] = useState(false);
  const [reviewOverrideReason, setReviewOverrideReason] = useState("");
  const [pending, startTransition] = useTransition();
  const clip = useMemo(() => clips.find((item) => item.id === clipId), [clipId, clips]);
  const account = useMemo(() => accounts.find((item) => item.id === accountId), [accountId, accounts]);
  const clipItems = useMemo(() => clips.map((item) => ({ value: item.id, label: `${item.projectTitle} — ${item.title}` })), [clips]);
  const accountItems = useMemo(() => accounts.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.platform.replace("_", " ")}` })), [accounts]);
  const ratioItems = useMemo(() => (clip?.aspectRatios ?? []).map((value) => ({ value, label: value.replace("ratio_", "").replaceAll("_", ":") })), [clip]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!clip || !account || !scheduledFor) return setFeedback("Choose a clip, account, and publish time.");
    setFeedback(null);
    startTransition(async () => {
      const request = {
        projectId: clip.projectId,
        clipId: clip.id,
        editorRevision: clip.editorRevision,
        accountId: account.id,
        platform: account.platform,
        caption,
        aspectRatio: ratioMap[ratio],
        resolution,
        scheduledFor,
        providerSettings: {},
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
      const result = await scheduleWorkspacePostAction({
        clientIdempotencyKey: intentKeys.forRequest(request),
        projectId: clip.projectId,
        clipId: clip.id,
        expectedEditorRevision: clip.editorRevision,
        accountId: account.id,
        platform: account.platform,
        caption,
        scheduledLocal: scheduledFor,
        aspectRatio: ratio,
        resolution,
        reviewOverrideReason: request.reviewOverrideReason,
      });
      if (!result.ok) {
		const resultCode = "errorCode" in result ? result.errorCode : result.code;
        if (resultCode === "review_approval_required") {
		  setApprovalBlocked(true);
		  setFeedback(null);
		  return;
		}
        return setFeedback(
          authenticatedActionResultMessage(result, "Could not schedule post."),
        );
      }
      intentKeys.confirm(request);
      setApprovalBlocked(false);
      setReviewOverrideReason("");
      router.push("/calendar");
      router.refresh();
    });
  }

  if (clips.length === 0 || accounts.length === 0) {
    return <Text color="fg.muted" fontSize="13px">{clips.length === 0 ? "Create a completed export before scheduling a post." : "Ask a workspace Owner or Admin to connect a social account first."}</Text>;
  }

  return (
    <Stack as="form" onSubmit={submit} gap="5" borderTopWidth="1px" borderColor="border" pt="6">
      <Stack gap="1.5"><chakra.label htmlFor="calendar-clip" fontSize="12px" fontWeight="550">Workspace clip</chakra.label><Combobox id="calendar-clip" ariaLabel="Workspace clip" value={clipId} onValueChange={(value) => { const next = clips.find((item) => item.id === value); setClipId(value); setRatio(next?.aspectRatios[0] ?? "ratio_9_16"); setApprovalBlocked(false); setReviewOverrideReason(""); }} items={clipItems} placeholder="Search completed clips" /></Stack>
      <Flex gap="4" direction={{ base: "column", md: "row" }}>
        <Stack gap="1.5" flex="1"><chakra.label htmlFor="calendar-account" fontSize="12px" fontWeight="550">Social account</chakra.label><Select id="calendar-account" ariaLabel="Social account" value={accountId} onValueChange={setAccountId} items={accountItems} /></Stack>
        <Stack gap="1.5" minW="150px"><chakra.label htmlFor="calendar-ratio" fontSize="12px" fontWeight="550">Format</chakra.label><Select id="calendar-ratio" ariaLabel="Clip format" value={ratio} onValueChange={(value) => { setRatio(value as ClipAspectRatio); setApprovalBlocked(false); setReviewOverrideReason(""); }} items={ratioItems} /></Stack>
        <Stack gap="1.5" minW="150px"><chakra.label htmlFor="calendar-resolution" fontSize="12px" fontWeight="550">Resolution</chakra.label><Select id="calendar-resolution" ariaLabel="Video resolution" value={resolution} onValueChange={(value) => { setResolution(value as "720p" | "1080p"); setApprovalBlocked(false); setReviewOverrideReason(""); }} items={[{ value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }]} /></Stack>
      </Flex>
      <Stack gap="1.5"><chakra.label htmlFor="calendar-caption" fontSize="12px" fontWeight="550">Caption</chakra.label><chakra.textarea id="calendar-caption" value={caption} onChange={(event) => setCaption(event.target.value)} minH="140px" maxLength={2200} required borderColor="border.control" borderRadius="l2" p="3" /><Text textStyle="data" fontSize="11px" color="fg.subtle" textAlign="right">{caption.length}/2200</Text></Stack>
      <Stack gap="1.5"><chakra.label htmlFor="calendar-time" fontSize="12px" fontWeight="550">Publish time</chakra.label><DateTimePicker id="calendar-time" ariaLabel="Publish date and time" value={scheduledFor} onValueChange={setScheduledFor} timezone={timezone} /><Text fontSize="11px" color="fg.subtle">Interpreted in the workspace timezone: {timezone}. Times skipped or repeated by daylight saving changes are rejected.</Text></Stack>
      {approvalBlocked ? (
        <ReviewApprovalCheckpoint
          projectId={clip?.projectId ?? ""}
          canOverride={canOverrideReview}
          reason={reviewOverrideReason}
          onReasonChange={setReviewOverrideReason}
          inputId="calendar-review-override"
        />
      ) : null}
      {feedback ? <Text fontSize="12px" color="danger.fg">{feedback}</Text> : null}
      <Flex justify="flex-end"><Button type="submit" disabled={pending || !reviewApprovalOverrideReady({ blocked: approvalBlocked, canOverride: canOverrideReview, reason: reviewOverrideReason })}>{pending ? <Spinner size="xs" /> : null}{approvalBlocked ? "Override & schedule" : "Schedule post"}</Button></Flex>
    </Stack>
  );
}
