"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Send,
  Share2,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Box, Flex, Input, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { AccountAvatar } from "../../_components/account-menu";
import type { ReviewRoomData } from "./review-panel";
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
  available,
  actor,
}: {
  projectId: string;
  available: boolean;
  actor: {
    name: string;
    email: string | null;
    imageUrl: string | null;
    initials: string;
    role: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReviewRoomData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recipientText, setRecipientText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/review-rounds`;
  const activeRound = data ? activeShareRound(data) : null;
  const recipientEmails = useMemo(
    () => reviewerEmailsFromText(recipientText),
    [recipientText],
  );
  const invalidEmails = useMemo(
    () => invalidReviewerEmails(recipientText),
    [recipientText],
  );

  async function loadRoom() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Sharing details could not be loaded");
      }
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sharing details could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Sharing could not be updated");
      }
      await loadRoom();
      router.refresh();
      return payload;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sharing could not be updated");
      return null;
    } finally {
      setBusy(false);
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
    const result = await post("", buildQuickReviewRoundInput(data, recipientEmails));
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
    const result = await post(`/${activeRound.id}/invite`, { recipientEmails });
    if (result) {
      setRecipientText("");
      setNotice(result.addedCount === 0 ? "Those reviewers already have access." : "Invitation queued.");
    }
  }

  async function copyLink() {
    if (!activeRound?.path) return;
    try {
      await navigator.clipboard.writeText(
        new URL(activeRound.path, window.location.origin).toString(),
      );
      setError(null);
      setNotice("Review link copied.");
    } catch {
      setNotice(null);
      setError("Copy failed. Open the review room and copy its address instead.");
    }
  }

  const approval = activeRound ? reviewApprovalProgress(activeRound) : null;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open && available && !data && !loading) void loadRoom();
      }}
      positioning={{ placement: "bottom-end", offset: { mainAxis: 8 } }}
    >
      <Popover.Trigger asChild>
        <Button size="sm" colorPalette="accent">
          <Share2 size={15} aria-hidden /> Share
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            layerStyle="panel"
            boxShadow="cardHover"
            borderColor="border"
            w={{ base: "calc(100vw - 24px)", sm: "420px" }}
            maxW="420px"
            overflow="hidden"
          >
            <Stack gap="0">
              <Box px="5" pt="5" pb="4" borderBottomWidth="1px" borderColor="border.subtle">
                <Text textStyle="title" fontSize="lg">Share this project</Text>
                <Text color="fg.muted" fontSize="sm" mt="1">
                  Send one private link for review, comments, and approval.
                </Text>
              </Box>

              {!available ? (
                <Stack gap="4" p="5">
                  <Flex gap="3" align="start">
                    <ShieldCheck size={18} aria-hidden />
                    <Box>
                      <Text fontWeight="650" fontSize="sm">Review sharing is a Business feature</Text>
                      <Text color="fg.muted" fontSize="sm" mt="1">Upgrade once, then every project can use this flow without setup flags.</Text>
                    </Box>
                  </Flex>
                  <Button asChild size="sm"><Link href="/settings/billing">View Business plan</Link></Button>
                </Stack>
              ) : loading && !data ? (
                <Flex minH="190px" align="center" justify="center" gap="2" color="fg.muted">
                  <Spinner size="sm" />
                  <Text fontSize="sm">Loading sharing…</Text>
                </Flex>
              ) : data ? (
                <Stack gap="0">
                  {activeRound ? (
                    <>
                      <Flex px="5" py="4" align="center" gap="3" borderBottomWidth="1px" borderColor="border.subtle">
                        <Flex w="32px" h="32px" align="center" justify="center" borderRadius="full" bg="accent.subtle" color="accent.fg" flexShrink={0}>
                          <Link2 size={15} aria-hidden />
                        </Flex>
                        <Box minW="0" flex="1">
                          <Text fontSize="sm" fontWeight="650">Anyone with the link can review</Text>
                          <Text fontSize="xs" color="fg.muted">Private link · round {activeRound.revision}</Text>
                        </Box>
                        <Button size="xs" variant="outline" onClick={() => void copyLink()}>
                          <Copy size={13} aria-hidden /> Copy link
                        </Button>
                      </Flex>

                      {activeRound.newerWorkAvailable ? (
                        <Flex px="5" py="3" gap="2" color="warning.fg" bg="warning.subtle">
                          <AlertTriangle size={14} aria-hidden />
                          <Text fontSize="xs">Newer edits are ready. Start a new round from Review details when you want to share them.</Text>
                        </Flex>
                      ) : null}

                      <Stack gap="3" px="5" py="4" borderBottomWidth="1px" borderColor="border.subtle">
                        <Flex align="center" gap="2">
                          <UserPlus size={15} aria-hidden />
                          <Text fontSize="sm" fontWeight="650">Invite people</Text>
                        </Flex>
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
                            borderColor="border.control"
                          />
                          <Button size="sm" onClick={() => void invite()} disabled={busy || recipientEmails.length === 0}>
                            {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Send size={14} aria-hidden />}
                            Invite
                          </Button>
                        </Flex>
                        {activeRound.recipientEmails.length > 0 ? (
                          <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                            Shared with {activeRound.recipientEmails.join(", ")}
                          </Text>
                        ) : (
                          <Text fontSize="xs" color="fg.subtle">No email invitations yet. The link is ready to copy.</Text>
                        )}
                      </Stack>

                      <Flex px="5" py="3" gap="3" align="center" borderBottomWidth="1px" borderColor="border.subtle">
                        <AccountAvatar imageUrl={actor.imageUrl} initials={actor.initials} alt={actor.name} />
                        <Box minW="0" flex="1">
                          <Text fontSize="sm" fontWeight="650" truncate>{actor.name}</Text>
                          <Text fontSize="xs" color="fg.muted" truncate>{actor.email ?? "Narriflow team member"}</Text>
                        </Box>
                        <Text fontSize="xs" color="fg.subtle" textTransform="capitalize">{actor.role}</Text>
                      </Flex>

                      <Flex px="5" py="4" gap="3" align="center" borderBottomWidth="1px" borderColor="border.subtle">
                        <ShieldCheck size={16} aria-hidden />
                        <Box flex="1">
                          <Flex justify="space-between" gap="3">
                            <Text fontSize="sm" fontWeight="650">Approval</Text>
                            <Text textStyle="data" fontSize="xs" color="fg.muted">
                              {activeRound.approvalRequired && approval
                                ? `${approval.approved}/${approval.required} approved`
                                : "Optional"}
                            </Text>
                          </Flex>
                          {activeRound.approvalRequired && approval && approval.required > 0 ? (
                            <Box h="3px" bg="bg.muted" mt="2" overflow="hidden">
                              <Box h="full" bg="accent.solid" w={`${(approval.approved / approval.required) * 100}%`} />
                            </Box>
                          ) : null}
                        </Box>
                      </Flex>

                      <Flex px="5" py="4" gap="2">
                        <Button asChild size="sm" variant="outline" flex="1">
                          <Link href={activeRound.path ?? "#"} target="_blank" rel="noreferrer">
                            <ExternalLink size={14} aria-hidden /> Open room
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost" flex="1">
                          <Link href={`/projects/${projectId}?tab=review`}>Review details</Link>
                        </Button>
                      </Flex>
                    </>
                  ) : (
                    <Stack gap="4" p="5">
                      <Box>
                        <Text fontSize="sm" fontWeight="650">Create a review link</Text>
                        <Text fontSize="sm" color="fg.muted" mt="1">
                          Narriflow will include every latest ready clip. You can adjust versions and access controls later in Review details.
                        </Text>
                      </Box>
                      <Input
                        size="sm"
                        value={recipientText}
                        onChange={(event) => setRecipientText(event.target.value)}
                        placeholder="Reviewer email (optional)"
                        aria-label="Reviewer email addresses"
                        borderColor="border.control"
                      />
                      {quickReviewItems(data).length > 0 ? (
                        <Button onClick={() => void createLink()} disabled={busy}>
                          {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Link2 size={15} aria-hidden />}
                          Create review link
                        </Button>
                      ) : (
                        <Button asChild variant="outline">
                          <Link href={`/projects/${projectId}?tab=clips`}>Render a clip first</Link>
                        </Button>
                      )}
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/projects/${projectId}?tab=review`}>Advanced review settings</Link>
                      </Button>
                    </Stack>
                  )}

                  {notice ? (
                    <Flex role="status" aria-live="polite" px="5" py="3" gap="2" align="center" color="success.fg" borderTopWidth="1px" borderColor="border.subtle">
                      <Check size={14} aria-hidden />
                      <Text fontSize="xs">{notice}</Text>
                    </Flex>
                  ) : null}
                  {error ? (
                    <Flex role="alert" px="5" py="3" gap="2" align="center" color="danger.fg" borderTopWidth="1px" borderColor="border.subtle">
                      <AlertTriangle size={14} aria-hidden />
                      <Text fontSize="xs">{error}</Text>
                    </Flex>
                  ) : null}
                </Stack>
              ) : (
                <Stack gap="3" p="5">
                  <Text color="danger.fg" fontSize="sm">{error ?? "Sharing details could not be loaded."}</Text>
                  <Button size="sm" variant="outline" onClick={() => void loadRoom()}>Try again</Button>
                </Stack>
              )}
            </Stack>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
