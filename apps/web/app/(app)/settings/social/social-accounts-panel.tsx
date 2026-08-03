"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Image, Stack, Text } from "@chakra-ui/react";
import {
  Instagram,
  Link2,
  Linkedin,
  Music2,
  Trash2,
  Youtube,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  userErrorMessage,
  type SocialAccountSnapshot,
  type SocialPlatform,
} from "@narriflow/validators";

const platformLabels: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  linkedin: "LinkedIn",
  x: "X",
};

const platformHelp: Record<SocialPlatform, string> = {
  tiktok: "Direct video publishing through TikTok Content Posting API.",
  youtube_shorts: "Uploads rendered clips to the selected YouTube channel.",
  instagram_reels: "Publishes Reels through a connected Instagram Business or Creator account.",
  linkedin: "Publishes video posts to the connected LinkedIn member profile.",
  x: "Uploads video media and creates posts through X API v2.",
};

// Platform glyphs for the icon tile. X has no lucide glyph — it renders a
// display-face letter instead (see PlatformTile).
const platformIcons: Partial<
  Record<SocialPlatform, ComponentType<{ size?: number | string }>>
> = {
  tiktok: Music2,
  youtube_shorts: Youtube,
  instagram_reels: Instagram,
  linkedin: Linkedin,
};

function PlatformTile({ platform }: { platform: SocialPlatform }) {
  const Icon = platformIcons[platform];
  return (
    <Flex
      boxSize="10"
      align="center"
      justify="center"
      borderRadius="l2"
      bg="bg.muted"
      borderWidth="1px"
      borderColor="border"
      color="fg.muted"
      flexShrink={0}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon size={17} />
      ) : (
        <Text textStyle="display" fontSize="15px" lineHeight="1">
          X
        </Text>
      )}
    </Flex>
  );
}

const platforms = Object.keys(platformLabels) as SocialPlatform[];

function connectHref(platform: SocialPlatform) {
  return `/api/social/oauth/start/${platform}?redirect=/settings/social`;
}

export function SocialAccountsPanel({
  accounts,
  connectedCount,
  errorCode,
}: {
  accounts: SocialAccountSnapshot[];
  connectedCount: number | null;
  errorCode: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const callbackFired = useRef(false);

  // OAuth callback outcome: toast once, then strip the query params so a
  // refresh doesn't re-announce.
  useEffect(() => {
    if (!connectedCount && !errorCode) return;

    // Chakra's toaster flushes its external store synchronously. Schedule it
    // after React finishes flushing effects to avoid a nested flushSync.
    const timeoutId = window.setTimeout(() => {
      if (callbackFired.current) return;
      callbackFired.current = true;

      if (connectedCount) {
        toaster.create({
          type: "success",
          title: `Connected ${connectedCount} account${connectedCount === 1 ? "" : "s"}`,
        });
      } else if (errorCode) {
        toaster.create({
          type: "error",
          title: "Connection failed",
          description:
            userErrorMessage(errorCode) ??
            "Social connection failed. Please try connecting again.",
        });
      }
      router.replace("/settings/social", { scroll: false });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [connectedCount, errorCode, router]);

  async function disconnect(account: SocialAccountSnapshot) {
    const confirmed = await confirm({
      title: "Disconnect account?",
      description: `Scheduled posts that target ${account.displayName} will fail until you reconnect.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;

    setDisconnecting(account.id);
    try {
      const response = await fetch(`/api/social/accounts/${account.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        console.error("social_disconnect_failed", response.status, body);
        toaster.create({
          type: "error",
          title: "Could not disconnect",
          description:
            userErrorMessage(body?.error) ??
            "Could not disconnect this account. Please try again.",
        });
        return;
      }
      toaster.create({
        type: "success",
        title: "Account disconnected",
        description: `${account.displayName} was removed.`,
      });
      startTransition(() => router.refresh());
    } catch (err) {
      console.error("social_disconnect_failed", err);
      toaster.create({
        type: "error",
        title: "Could not disconnect",
        description: "Could not disconnect this account. Please try again.",
      });
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <Box as="section">
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        Platforms
      </Text>
      <Stack gap="0" layerStyle="band" pt="0">
        {platforms.map((platform) => {
          const platformAccounts = accounts.filter(
            (account) => account.platform === platform,
          );
          const isConnected = platformAccounts.length > 0;

          return (
            <Box
              key={platform}
              position="relative"
              borderBottomWidth="1px"
              borderColor="border"
              py="3.5"
              pl="4"
            >
              {/* 3px status stripe — connected reads success; label carries state */}
              <Box
                position="absolute"
                left="0"
                top="3.5"
                bottom="3.5"
                w="3px"
                borderRadius="full"
                bg={isConnected ? "success.solid" : "border"}
              />

              <Flex gap="3" align="flex-start">
                <PlatformTile platform={platform} />

                <Box flex="1" minW="0">
                  <Flex
                    align={{ base: "flex-start", md: "center" }}
                    justify="space-between"
                    gap="3.5"
                    direction={{ base: "column", md: "row" }}
                  >
                    <Box minW="0">
                      <Flex align="center" gap="3" wrap="wrap">
                        <Text fontSize="14px" fontWeight="600" color="fg">
                          {platformLabels[platform]}
                        </Text>
                        <StatusBadge
                          status={isConnected ? "ready" : "pending"}
                          label={
                            isConnected
                              ? `Connected · ${platformAccounts.length}`
                              : "Not connected"
                          }
                        />
                      </Flex>
                      <Text mt="0.5" fontSize="12px" color="fg.muted">
                        {platformHelp[platform]}
                      </Text>
                    </Box>

                    <Button asChild size="sm" variant="outline" colorPalette="gray" flexShrink={0}>
                      <Link href={connectHref(platform)}>
                        <Link2 size={14} />
                        {isConnected ? "Add another" : "Connect"}
                      </Link>
                    </Button>
                  </Flex>

                  {platformAccounts.length > 0 ? (
                    <Stack gap="0" mt="3">
                      {platformAccounts.map((account) => (
                    <Flex
                      key={account.id}
                      align="center"
                      justify="space-between"
                      gap="2.5"
                      py="2"
                      borderTopWidth="1px"
                      borderColor="border.subtle"
                    >
                      <Flex align="center" gap="2.5" minW="0">
                        <Flex
                          h="7"
                          w="7"
                          align="center"
                          justify="center"
                          overflow="hidden"
                          borderRadius="full"
                          bg="bg.muted"
                          borderWidth="1px"
                          borderColor="border"
                          color="fg.muted"
                          fontSize="12px"
                          fontWeight="600"
                          flexShrink={0}
                        >
                          {account.avatarUrl ? (
                            <Image
                              alt={account.displayName}
                              h="full"
                              w="full"
                              objectFit="cover"
                              src={account.avatarUrl}
                            />
                          ) : (
                            account.displayName.charAt(0).toUpperCase()
                          )}
                        </Flex>
                        <Box minW="0">
                          <Text fontSize="13px" color="fg" truncate>
                            {account.displayName}
                          </Text>
                          <Text
                            textStyle="data"
                            fontSize="11px"
                            color="fg.muted"
                            truncate
                          >
                            {account.handle ?? account.providerAccountId} · {account.status}
                          </Text>
                        </Box>
                      </Flex>

                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="danger"
                        loading={disconnecting === account.id}
                        disabled={isPending || disconnecting !== null}
                        onClick={() => void disconnect(account)}
                      >
                        <Trash2 size={12} />
                        Disconnect
                      </Button>
                    </Flex>
                  ))}
                    </Stack>
                  ) : null}
                </Box>
              </Flex>
            </Box>
          );
        })}
      </Stack>
      {dialog}
    </Box>
  );
}
