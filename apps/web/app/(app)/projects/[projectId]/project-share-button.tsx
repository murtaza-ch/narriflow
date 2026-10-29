"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { isApiError } from "@narriflow/api-client/core";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Film,
  Link2,
  MessageSquare,
  Play,
  Send,
  Share2,
  X,
} from "lucide-react";
import { Box, Flex, Input, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { AccountAvatar } from "../../_components/account-menu";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { useInternalReviews, type ReviewCommand } from "./review-panel";
import {
  activeShareRound,
  buildQuickReviewRoundInput,
  invalidReviewerEmails,
  quickReviewItems,
  reviewerEmailsFromText,
  reviewApprovalProgress,
} from "./project-share-model";

export function ProjectShareButton({
  projectId,
  upgrade,
  actor,
}: {
  projectId: string;
  /** What unlocks review rooms; `null` when the plan already has them. */
  upgrade: UpgradePrompt | null;
  actor: {
    name: string;
    email: string | null;
    imageUrl: string | null;
    initials: string;
    role: string;
  };
}) {
  const { openUpgrade } = useUpgrade();
  const [open, setOpen] = useState(false);
  const { room, mutation } = useInternalReviews(projectId, undefined, open && !upgrade);
  const data = room.data;
  const loading = room.isFetching;
  const busy = mutation.isPending;
  const [recipientText, setRecipientText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const activeRound = data ? activeShareRound(data) : null;
  const recipientEmails = useMemo(
    () => reviewerEmailsFromText(recipientText),
    [recipientText],
  );
  const invalidEmails = useMemo(
    () => invalidReviewerEmails(recipientText),
    [recipientText],
  );

  async function post(command: ReviewCommand) {
    setError(null);
    setNotice(null);
    try {
      return await mutation.mutateAsync(command);
    } catch (reason) {
      const prompt = isApiError(reason) ? upgradePromptFromFailure({ error: reason.code, message: reason.message, ...(reason.details ? { details: reason.details } : {}) }) : null;
      if (prompt) openUpgrade(prompt);
      setError(reason instanceof Error ? reason.message : "Sharing could not be updated");
      return null;
    }
  }

  async function createLink() {
    if (!data) return;
    if (invalidEmails.length > 0) {
      setError(`Check ${invalidEmails[0]}.`);
      return;
    }
    if (quickReviewItems(data).length === 0) {
      setError("Render at least one clip before creating a review link.");
      return;
    }
    const result = await post({ kind: "create", input: buildQuickReviewRoundInput(data, recipientEmails) });
    if (result) {
      setRecipientText("");
      setNotice("Review link created.");
    }
  }

  async function invite() {
    if (!activeRound || recipientEmails.length === 0) return;
    if (invalidEmails.length > 0) {
      setError(`Check ${invalidEmails[0]}.`);
      return;
    }
    const result = await post({ kind: "invite", roundId: activeRound.id, input: { recipientEmails } });
    if (result) {
      setRecipientText("");
      setNotice("addedCount" in result && result.addedCount === 0 ? "Those reviewers already have access." : "Invitation queued.");
    }
  }

  async function copyLink() {
    if (!activeRound?.path) return;
    try {
      await navigator.clipboard.writeText(
        new URL(activeRound.path, window.location.origin).toString(),
      );
      setError(null);
      setNotice(null);
      // The button itself confirms, then turns back into Copy.
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice(null);
      setError("Copy failed. Open the review room and copy its address instead.");
    }
  }

  const approval = activeRound ? reviewApprovalProgress(activeRound) : null;
  const readyClips = data ? quickReviewItems(data).length : 0;
  const invalid = new Set(invalidEmails);
  const removeRecipient = (email: string) =>
    setRecipientText(recipientEmails.filter((item) => item !== email).join(", "));
  const recipientChips =
    recipientEmails.length > 0 ? (
      <Flex gap="1.5" wrap="wrap">
        {recipientEmails.map((email) => (
          <RecipientChip
            key={email}
            email={email}
            invalid={invalid.has(email)}
            onRemove={() => removeRecipient(email)}
          />
        ))}
      </Flex>
    ) : null;

  if (upgrade) {
    return (
      <LockedButton size="sm" variant="subtle" prompt={upgrade}>
        <Share2 size={16} aria-hidden /> Share
      </LockedButton>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);

      }}
      positioning={{ placement: "bottom-end", offset: { mainAxis: 8 } }}
    >
      <Popover.Trigger asChild>
        <Button size="sm" variant="subtle">
          <Share2 size={16} aria-hidden /> Share
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w={{ base: "calc(100vw - 24px)", sm: "400px" }}
            maxW="400px"
            maxH="min(680px, 85vh)"
            overflowY="auto"
          >
            <Stack gap="0">
              <Box px="5" pt="5" pb="4">
                {!activeRound ? <ReviewRoomArt /> : null}
                <Text textStyle="title" fontSize="lg">Share for review</Text>
                <Text color="fg.muted" fontSize="sm" mt="1">
                  {activeRound
                    ? "Anyone with the link can watch, comment and approve."
                    : "One private link to watch, comment and approve. Reviewers don't need an account."}
                </Text>
              </Box>

              {loading && !data ? (
                <Flex minH="160px" align="center" justify="center" gap="2" color="fg.muted">
                  <Spinner size="sm" />
                  <Text fontSize="sm">Loading sharing…</Text>
                </Flex>
              ) : data ? (
                <Stack gap="0">
                  {activeRound ? (
                    <Stack gap="5" px="5" pb="5">
                      <Stack gap="2">
                        <Flex align="center" gap="2" h="10" ps="3" pe="1" bg="bg.soft" borderRadius="l2" minW="0">
                          <Box color="accent.fg" flexShrink={0}>
                            <Link2 size={15} aria-hidden />
                          </Box>
                          <Text flex="1" minW="0" truncate fontSize="13px" color="fg.muted">
                            {activeRound.path}
                          </Text>
                          <Button size="xs" variant={copied ? "subtle" : "solid"} onClick={() => void copyLink()}>
                            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                            {copied ? "Copied" : "Copy link"}
                          </Button>
                        </Flex>
                        <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
                          Round {activeRound.revision} · {activeRound.items.length}{" "}
                          {activeRound.items.length === 1 ? "clip" : "clips"}
                        </Text>
                      </Stack>

                      {activeRound.newerWorkAvailable ? (
                        <Flex px="3" py="2.5" gap="2" color="warning.fg" bg="warning.subtle" borderRadius="l2">
                          <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                          <Text fontSize="xs">Newer edits are ready. Start a new round from Review details to share them.</Text>
                        </Flex>
                      ) : null}

                      <Stack gap="2.5">
                        <Text fontSize="13px" fontWeight="500">Invite people</Text>
                        <Flex gap="2" align="start">
                          <Input
                            size="sm"
                            value={recipientText}
                            onChange={(event) => setRecipientText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void invite();
                              }
                            }}
                            placeholder="name@company.com"
                            aria-label="Reviewer email addresses"
                          />
                          <Button size="sm" onClick={() => void invite()} disabled={busy || recipientEmails.length === 0}>
                            {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Send size={16} aria-hidden />}
                            Invite
                          </Button>
                        </Flex>
                        {recipientChips}
                      </Stack>

                      <Stack gap="2.5">
                        <Text fontSize="13px" fontWeight="500">People with access</Text>
                        <Stack gap="2">
                          <Flex gap="3" align="center">
                            <AccountAvatar imageUrl={actor.imageUrl} initials={actor.initials} alt={actor.name} />
                            <Box minW="0" flex="1">
                              <Text fontSize="13px" fontWeight="500" truncate>{actor.name} (you)</Text>
                              <Text fontSize="12px" color="fg.muted" truncate>{actor.email ?? "Narriflow team member"}</Text>
                            </Box>
                            <Text fontSize="12px" color="fg.subtle" textTransform="capitalize">{actor.role}</Text>
                          </Flex>
                          {activeRound.recipientEmails.map((email) => (
                            <Flex key={email} gap="3" align="center">
                              <EmailAvatar email={email} />
                              <Text flex="1" minW="0" fontSize="13px" truncate>{email}</Text>
                              <Text fontSize="12px" color="fg.subtle">Invited</Text>
                            </Flex>
                          ))}
                        </Stack>
                      </Stack>

                      <Stack gap="2">
                        <Flex justify="space-between" gap="3">
                          <Text fontSize="13px" fontWeight="500">Approval</Text>
                          <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                            {activeRound.approvalRequired && approval
                              ? `${approval.approved} of ${approval.required} approved`
                              : "Optional"}
                          </Text>
                        </Flex>
                        {activeRound.approvalRequired && approval && approval.required > 0 ? (
                          <Box h="6px" bg="bg.soft" borderRadius="full" overflow="hidden">
                            <Box
                              h="full"
                              bg="accent.solid"
                              borderRadius="full"
                              style={{ width: `${Math.max(2, (approval.approved / approval.required) * 100)}%` }}
                            />
                          </Box>
                        ) : null}
                      </Stack>

                      <Flex gap="2">
                        <Button asChild size="sm" variant="subtle" flex="1">
                          <Link href={activeRound.path ?? "#"} target="_blank" rel="noreferrer">
                            <ExternalLink size={16} aria-hidden /> Open room
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost" flex="1">
                          <Link href={`/projects/${projectId}?tab=review`}>Review details</Link>
                        </Button>
                      </Flex>
                    </Stack>
                  ) : (
                    <Stack gap="4" px="5" pb="5">
                      <Flex align="center" gap="2" fontSize="13px" color={readyClips > 0 ? "fg.muted" : "fg.subtle"}>
                        <Film size={14} aria-hidden />
                        {readyClips > 0
                          ? `Includes ${readyClips} ready ${readyClips === 1 ? "clip" : "clips"}, latest versions`
                          : "No rendered clips yet"}
                      </Flex>
                      <Stack gap="2">
                        <Input
                          size="sm"
                          value={recipientText}
                          onChange={(event) => setRecipientText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && readyClips > 0) {
                              event.preventDefault();
                              void createLink();
                            }
                          }}
                          placeholder="Add reviewer emails (optional)"
                          aria-label="Reviewer email addresses"
                        />
                        {recipientChips}
                        {recipientEmails.length > invalidEmails.length ? (
                          <Text fontSize="12px" color="fg.subtle">
                            {recipientEmails.length - invalidEmails.length === 1 ? "They'll" : "Each will"} get the link by email.
                          </Text>
                        ) : null}
                      </Stack>
                      {readyClips > 0 ? (
                        <Button onClick={() => void createLink()} disabled={busy}>
                          {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Link2 size={16} aria-hidden />}
                          Create review link
                        </Button>
                      ) : (
                        <Button asChild variant="subtle">
                          <Link href={`/projects/${projectId}?tab=clips`}>Render a clip first</Link>
                        </Button>
                      )}
                      <Button asChild size="sm" variant="ghost" color="fg.muted">
                        <Link href={`/projects/${projectId}?tab=review`}>Choose clips, passcode or expiry</Link>
                      </Button>
                    </Stack>
                  )}

                  {notice ? (
                    <Flex role="status" aria-live="polite" px="5" pb="4" mt="-1" gap="2" align="center" color="accent.fg">
                      <Check size={14} aria-hidden />
                      <Text fontSize="xs">{notice}</Text>
                    </Flex>
                  ) : null}
                  {error ? (
                    <Flex role="alert" px="5" pb="4" mt="-1" gap="2" align="center" color="danger.fg">
                      <AlertTriangle size={14} aria-hidden />
                      <Text fontSize="xs">{error}</Text>
                    </Flex>
                  ) : null}
                </Stack>
              ) : (
                <Stack gap="3" px="5" pb="5">
                  <Text color="danger.fg" fontSize="sm">{error ?? room.error?.message ?? "Sharing details could not be loaded."}</Text>
                  <Button size="sm" variant="subtle" onClick={() => void room.refetch()}>Try again</Button>
                </Stack>
              )}
            </Stack>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

/** A typed address, ready to send or flagged to fix, with a way to drop it. */
function RecipientChip({ email, invalid, onRemove }: { email: string; invalid: boolean; onRemove: () => void }) {
  return (
    <Flex
      align="center"
      gap="1.5"
      h="7"
      ps="1"
      pe="1"
      maxW="full"
      borderRadius="full"
      bg={invalid ? "danger.subtle" : "bg.soft"}
      color={invalid ? "danger.fg" : "fg"}
      fontSize="12px"
      title={invalid ? "Check this address" : undefined}
    >
      <EmailAvatar email={email} size="5" />
      <Text as="span" truncate>{email}</Text>
      <Flex
        as="button"
        aria-label={`Remove ${email}`}
        boxSize="5"
        flexShrink={0}
        align="center"
        justify="center"
        borderRadius="full"
        color="fg.subtle"
        _hover={{ bg: "bg.softHover", color: "fg" }}
        onClick={onRemove}
      >
        <X size={12} aria-hidden />
      </Flex>
    </Flex>
  );
}

function EmailAvatar({ email, size = "8" }: { email: string; size?: string }) {
  return (
    <Flex
      boxSize={size}
      flexShrink={0}
      align="center"
      justify="center"
      borderRadius="full"
      bg="accent.subtle"
      color="accent.fg"
      fontSize={size === "8" ? "13px" : "10px"}
      fontWeight="600"
      aria-hidden
    >
      {email.charAt(0).toUpperCase()}
    </Flex>
  );
}

const CLIP_FILLS = [
  "linear-gradient(140deg,#c1d2f2,#5c6c96)",
  "linear-gradient(135deg,#8cace0,#31486f)",
  "linear-gradient(140deg,#c9bcf0,#74619e)",
];

/** What a review room is, drawn: clips to watch, a comment on a moment, an approval. */
function ReviewRoomArt() {
  return (
    <Box position="relative" h="128px" mb="4" borderRadius="l3" bg="bg.subtle" overflow="hidden" aria-hidden>
      <Flex position="absolute" inset="0" align="center" justify="center">
        {CLIP_FILLS.map((fill, index) => (
          <Flex
            key={fill}
            w="46px"
            h="80px"
            ms={index ? "-4px" : "0"}
            zIndex={index === 1 ? 1 : 0}
            align="center"
            justify="center"
            borderRadius="8px"
            color="white"
            transform={`rotate(${(index - 1) * 9}deg)${index === 1 ? " translateY(-4px)" : ""}`}
            style={{ backgroundImage: fill }}
          >
            {index === 1 ? <Play size={14} fill="currentColor" /> : null}
          </Flex>
        ))}
      </Flex>
      <Flex
        position="absolute"
        top="4"
        right="6"
        align="center"
        gap="1.5"
        px="2.5"
        py="1.5"
        bg="bg.panel"
        borderRadius="10px 10px 10px 3px"
        fontSize="11px"
        color="fg"
      >
        <MessageSquare size={11} />
        Love this hook
        <Text as="span" textStyle="data" fontSize="10px" color="fg.subtle">0:04</Text>
      </Flex>
      <Flex
        position="absolute"
        bottom="4"
        left="6"
        align="center"
        gap="1"
        h="6"
        px="2.5"
        bg="accent.subtle"
        color="accent.fg"
        borderRadius="full"
        fontSize="11px"
        fontWeight="500"
      >
        <Check size={12} />
        Approved
      </Flex>
    </Box>
  );
}
