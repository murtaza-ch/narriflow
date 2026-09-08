"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Image, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  userErrorMessage,
  type SocialAccountSnapshot,
  type SocialPlatform,
} from "@narriflow/validators";

const platformLabels: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  youtube_shorts: "YouTube",
  instagram_reels: "Instagram",
  facebook_reels: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
};

const platformIcons: Record<SocialPlatform, { light: string; dark?: string }> = {
  tiktok: { light: "tiktok-light.svg", dark: "tiktok-dark.svg" },
  youtube_shorts: { light: "youtube.svg" },
  instagram_reels: { light: "instagram.svg" },
  facebook_reels: { light: "facebook.svg" },
  linkedin: { light: "linkedin.svg" },
  x: { light: "x-light.svg", dark: "x-dark.svg" },
};

function PlatformTile({ platform, compact = false }: { platform: SocialPlatform; compact?: boolean }) {
  const icon = platformIcons[platform];
  return (
    <Flex boxSize={compact ? "4" : "10"} align="center" justify="center" flexShrink={0} aria-hidden="true">
      <Image
        src={`/images/social/${icon.light}`}
        alt=""
        boxSize={compact ? "3.5" : "7"}
        objectFit="contain"
        bg={platform === "linkedin" ? "white" : undefined}
        borderRadius={platform === "linkedin" ? "2px" : undefined}
        display="block"
        _dark={icon.dark ? { display: "none" } : undefined}
      />
      {icon.dark ? <Image src={`/images/social/${icon.dark}`} alt="" boxSize={compact ? "3.5" : "7"} objectFit="contain" display="none" _dark={{ display: "block" }} /> : null}
    </Flex>
  );
}

const platforms: SocialPlatform[] = ["tiktok", "youtube_shorts", "instagram_reels", "facebook_reels", "x", "linkedin"];

function connectHref(platform: SocialPlatform) {
  return `/api/social/oauth/start/${platform}?redirect=/settings/social-accounts`;
}

function SocialAvatar({
  src,
  name,
  size = "10",
}: {
  src: string | null;
  name: string;
  size?: "8" | "10";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <Flex
      boxSize={size}
      flexShrink={0}
      borderRadius="full"
      overflow="hidden"
      align="center"
      justify="center"
      bg="bg.muted"
      color="fg.muted"
      fontSize={size === "10" ? "sm" : "xs"}
      fontWeight="600"
      aria-hidden="true"
    >
      {src && failedSrc !== src ? (
        <Image
          src={src}
          alt=""
          boxSize="full"
          objectFit="cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        name.trim().charAt(0).toUpperCase() || "?"
      )}
    </Flex>
  );
}

export function SocialAccountsPanel({
  accounts,
  connectedCount,
  errorCode,
  facebookSelectionToken,
  canManage,
}: {
  accounts: SocialAccountSnapshot[];
  connectedCount: number | null;
  errorCode: string | null;
  facebookSelectionToken: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [facebookPages, setFacebookPages] = useState<Array<{ id: string; name: string | null; avatarUrl: string | null }>>([]);
  const [selectingPage, setSelectingPage] = useState<string | null>(null);
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
      router.replace("/settings/social-accounts", { scroll: false });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [connectedCount, errorCode, router]);

  useEffect(() => {
    if (!facebookSelectionToken) return;
    fetch(`/api/social/oauth/facebook-selection/${encodeURIComponent(facebookSelectionToken)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "Facebook Pages could not be loaded");
        setFacebookPages(payload.pages);
      })
      .catch((reason) => toaster.create({ type: "error", title: "Could not load Facebook Pages", description: reason instanceof Error ? reason.message : "Try connecting Facebook again." }));
  }, [facebookSelectionToken]);

  async function selectFacebookPage(pageId: string) {
    if (!facebookSelectionToken) return;
    setSelectingPage(pageId);
    try {
      const response = await fetch(`/api/social/oauth/facebook-selection/${encodeURIComponent(facebookSelectionToken)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Facebook Page could not be connected");
      toaster.create({ type: "success", title: "Facebook Page connected", description: payload.account.displayName });
      router.replace("/settings/social-accounts", { scroll: false });
      startTransition(() => router.refresh());
    } catch (reason) {
      toaster.create({ type: "error", title: "Could not connect Facebook Page", description: reason instanceof Error ? reason.message : "Try connecting Facebook again." });
    } finally {
      setSelectingPage(null);
    }
  }

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
        console.warn(JSON.stringify({ level: "error", message: "social_disconnect_failed", status: response.status }));
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
      console.warn(JSON.stringify({ level: "error", message: "social_disconnect_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
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
      {facebookSelectionToken && facebookPages.length > 0 ? (
        <Box mb="6" borderTopWidth="3px" borderColor="accent.solid" pt="4">
          <Text textStyle="eyebrow" color="accent.fg">Choose one Facebook Page</Text>
          <Text mt="1" fontSize="13px" color="fg.muted">Only the Page you choose will be connected to this workspace.</Text>
          <Stack mt="3" gap="0" borderTopWidth="1px" borderColor="border">
            {facebookPages.map((page) => (
              <Flex key={page.id} py="3" align="center" gap="3" borderBottomWidth="1px" borderColor="border.subtle">
                <SocialAvatar src={page.avatarUrl} name={page.name ?? "Facebook Page"} size="8" />
                <Text flex="1" fontSize="13px" fontWeight="600">{page.name ?? "Facebook Page"}</Text>
                <Button size="sm" variant="outline" disabled={selectingPage !== null} onClick={() => selectFacebookPage(page.id)}>{selectingPage === page.id ? "Connecting…" : "Connect"}</Button>
              </Flex>
            ))}
          </Stack>
        </Box>
      ) : null}
      {accounts.length > 0 ? (
        <Stack gap="3" mb="8" maxW="600px">
          <Text as="h2" fontSize="sm" fontWeight="600">Connected accounts</Text>
          <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="3" css={{ "@media (min-width: 360px) and (max-width: 479px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } }}>
          {accounts.map((account) => (
            <Flex key={account.id} direction="column" gap="3" align="center" minW="0" p="4" borderWidth="1px" borderColor="border.subtle" borderRadius="l2" bg="bg.panel">
              <Box position="relative" flexShrink={0}>
                <SocialAvatar src={account.avatarUrl} name={account.displayName} />
                <Flex position="absolute" bottom="-1" right="-1" boxSize="5" align="center" justify="center" borderRadius="full" bg="bg.panel" borderWidth="2px" borderColor="bg.panel" role="img" aria-label={platformLabels[account.platform]} title={platformLabels[account.platform]}>
                  <PlatformTile platform={account.platform} compact />
                </Flex>
              </Box>
              <Box flex="1" minW="0" w="full" textAlign="center">
                <Text fontSize="sm" fontWeight="600" overflowWrap="anywhere">{account.displayName}</Text>
                <Text fontSize="xs" color="fg.muted" overflowWrap="anywhere">{account.handle ?? account.providerAccountId}</Text>
                {account.status !== "active" ? <Text fontSize="xs" color="fg.muted" textTransform="capitalize">{account.status.replaceAll("_", " ")}</Text> : null}
              </Box>
              {canManage ? <Button size="sm" variant="ghost" colorPalette="danger" aria-label={`Disconnect ${account.displayName}`} loading={disconnecting === account.id} disabled={isPending || disconnecting !== null} onClick={() => void disconnect(account)}><Trash2 size={14} />Disconnect</Button> : null}
            </Flex>
          ))}
          </SimpleGrid>
        </Stack>
      ) : null}
      <Stack gap="2" mb="5" maxW="560px">
        <Text as="h2" fontSize="sm" fontWeight="600">{accounts.length ? "Add an account" : "Connect your first social account"}</Text>
        <Text fontSize="13px" color="fg.muted">{canManage ? "Sign in to the social account you want to add, then choose a platform below." : "Ask a workspace owner or admin to connect a social account."}</Text>
      </Stack>
      <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="3" maxW="600px" css={{ "@media (min-width: 360px) and (max-width: 479px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } }}>
        {platforms.map((platform) => {
          const content = <Stack key={platform} gap="3" align="center" justify="center" minH="132px" p="5"><PlatformTile platform={platform} /><Text fontSize="13px" fontWeight="500">{platformLabels[platform]}</Text></Stack>;
          return canManage ? (
            <Box key={platform} asChild borderWidth="1px" borderStyle="dashed" borderColor="border" borderRadius="l2" transition="background 120ms ease, border-color 120ms ease" _hover={{ bg: "bg.subtle", borderColor: "fg.subtle" }} _focusVisible={{ outline: "2px solid", outlineColor: "accent.solid", outlineOffset: "3px" }}>
              <Link href={connectHref(platform)} aria-label={`Connect ${platformLabels[platform]} account`}>{content}</Link>
            </Box>
          ) : <Box key={platform} borderWidth="1px" borderStyle="dashed" borderColor="border" borderRadius="l2" color="fg.muted">{content}</Box>;
        })}
      </SimpleGrid>
      {dialog}
    </Box>
  );
}
