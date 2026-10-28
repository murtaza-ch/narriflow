"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { AccessNote, type WorkspaceAccess } from "../_components/access-note";
import { UpgradeGem, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { Box, Flex, Image, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { BrandTile } from "../../integrations/_components/brand-tile";
import { SettingsCard, StatusPill } from "../_components/settings-ui";
import { Button } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import {
	PLAN_CATALOG,
	SOCIAL_PROVIDER_CAPABILITIES,
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

const platformIcons: Record<SocialPlatform, { light: string; dark?: string }> =
	{
		tiktok: { light: "tiktok-light.svg", dark: "tiktok-dark.svg" },
		youtube_shorts: { light: "youtube.svg" },
		instagram_reels: { light: "instagram.svg" },
		facebook_reels: { light: "facebook.svg" },
		linkedin: { light: "linkedin.svg" },
		x: { light: "x-light.svg", dark: "x-dark.svg" },
	};

function PlatformTile({
	platform,
	compact = false,
}: {
	platform: SocialPlatform;
	compact?: boolean;
}) {
	const icon = platformIcons[platform];
	return (
		<Flex
			boxSize={compact ? "4" : "10"}
			align="center"
			justify="center"
			flexShrink={0}
			aria-hidden="true"
		>
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
			{icon.dark ? (
				<Image
					src={`/images/social/${icon.dark}`}
					alt=""
					boxSize={compact ? "3.5" : "7"}
					objectFit="contain"
					display="none"
					_dark={{ display: "block" }}
				/>
			) : null}
		</Flex>
	);
}

/** What each platform receives, shown under its name. */
const platformFormats: Record<SocialPlatform, string> = {
	tiktok: "Short videos",
	youtube_shorts: "Shorts",
	instagram_reels: "Reels",
	facebook_reels: "Page Reels",
	linkedin: "Video posts",
	x: "Video posts",
};

const platforms: SocialPlatform[] = [
	"tiktok",
	"youtube_shorts",
	"instagram_reels",
	"facebook_reels",
	"x",
	"linkedin",
];

function connectHref(platform: SocialPlatform, returnTo?: string) {
	if (returnTo)
		return `/api/social/oauth/start/${platform}?redirect=${encodeURIComponent(returnTo)}`;
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
	access,
	returnTo,
	accountLimit,
	connectRequirement,
	connectUpgrade,
	canManageBilling,
}: {
	accounts: SocialAccountSnapshot[];
	connectedCount: number | null;
	errorCode: string | null;
	facebookSelectionToken: string | null;
	canManage: boolean;
	/** Who is looking, so a member who can't connect is told why (role or billing). */
	access: WorkspaceAccess;
	returnTo?: string;
	/** Connected accounts the plan allows to publish. */
	accountLimit: number;
	/** Why the plan can't connect another account; `null` when it can. */
	connectRequirement: string | null;
	/** The plan with room for another account; `null` at the top plan, where only disconnecting helps. */
	connectUpgrade: UpgradePrompt | null;
	canManageBilling: boolean;
}) {
	const mayConnect = canManage && connectRequirement === null;
	const { openUpgrade } = useUpgrade();
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [disconnecting, setDisconnecting] = useState<string | null>(null);
	const [facebookPages, setFacebookPages] = useState<
		Array<{ id: string; name: string | null; avatarUrl: string | null }>
	>([]);
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
		fetch(
			`/api/social/oauth/facebook-selection/${encodeURIComponent(facebookSelectionToken)}`,
			{ cache: "no-store" },
		)
			.then(async (response) => {
				const payload = await response.json();
				if (!response.ok)
					throw new Error(
						payload.message || "Facebook Pages could not be loaded",
					);
				setFacebookPages(payload.pages);
			})
			.catch((reason) =>
				toaster.create({
					type: "error",
					title: "Could not load Facebook Pages",
					description:
						reason instanceof Error
							? reason.message
							: "Try connecting Facebook again.",
				}),
			);
	}, [facebookSelectionToken]);

	async function selectFacebookPage(pageId: string) {
		if (!facebookSelectionToken) return;
		setSelectingPage(pageId);
		try {
			const response = await fetch(
				`/api/social/oauth/facebook-selection/${encodeURIComponent(facebookSelectionToken)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ pageId }),
				},
			);
			const payload = await response.json();
			if (!response.ok)
				throw new Error(
					payload.message || "Facebook Page could not be connected",
				);
			toaster.create({
				type: "success",
				title: "Facebook Page connected",
				description: payload.account.displayName,
			});
			router.replace("/settings/social-accounts", { scroll: false });
			startTransition(() => router.refresh());
		} catch (reason) {
			toaster.create({
				type: "error",
				title: "Could not connect Facebook Page",
				description:
					reason instanceof Error
						? reason.message
						: "Try connecting Facebook again.",
			});
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
				console.warn(
					JSON.stringify({
						level: "error",
						message: "social_disconnect_failed",
						status: response.status,
					}),
				);
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
			console.warn(
				JSON.stringify({
					level: "error",
					message: "social_disconnect_failed",
					errorName: err instanceof Error ? err.name : "UnknownError",
				}),
			);
			toaster.create({
				type: "error",
				title: "Could not disconnect",
				description: "Could not disconnect this account. Please try again.",
			});
		} finally {
			setDisconnecting(null);
		}
	}

	const slotsUsed = accounts.filter((account) => account.status !== "revoked").length;
	return (
		<Stack as="section" gap="8">
			{facebookSelectionToken && facebookPages.length > 0 ? (
				<SettingsCard
					icon={<PlatformTile platform="facebook_reels" compact />}
					title="Choose one Facebook Page"
					description="Only the Page you choose will be connected to this workspace."
				>
					<Stack gap="1">
						{facebookPages.map((page) => (
							<Flex key={page.id} py="2.5" align="center" gap="3">
								<SocialAvatar
									src={page.avatarUrl}
									name={page.name ?? "Facebook Page"}
									size="8"
								/>
								<Text flex="1" fontSize="14px" fontWeight="500">
									{page.name ?? "Facebook Page"}
								</Text>
								<Button
									size="sm"
									variant="subtle"
									disabled={selectingPage !== null}
									onClick={() => selectFacebookPage(page.id)}
								>
									{selectingPage === page.id ? "Connecting…" : "Connect"}
								</Button>
							</Flex>
						))}
					</Stack>
				</SettingsCard>
			) : null}
			{accounts.length > 0 ? (
				<Stack gap="3">
					<Flex align="center" gap="2">
						<Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
							Connected accounts
						</Text>
						<Text as="span" h="5" px="2" display="inline-flex" alignItems="center" borderRadius="full" bg="bg.soft" fontSize="11.5px" color="fg.muted" fontVariantNumeric="tabular-nums">
							{accounts.length}
						</Text>
					</Flex>
					<SimpleGrid columns={{ base: 1, md: 2 }} gap="2">
						{accounts.map((account) => (
							<Flex
								key={account.id}
								align="center"
								gap="3.5"
								minW="0"
								p="3.5"
								borderRadius="12px"
								bg="bg.subtle"
							>
								<Box position="relative" flexShrink={0}>
									<SocialAvatar
										src={account.avatarUrl}
										name={account.displayName}
									/>
									<Flex
										position="absolute"
										bottom="-1"
										right="-1"
										boxSize="5"
										align="center"
										justify="center"
										borderRadius="full"
										bg="bg.panel"
										role="img"
										aria-label={platformLabels[account.platform]}
										title={platformLabels[account.platform]}
									>
										<PlatformTile platform={account.platform} compact />
									</Flex>
								</Box>
								<Stack gap="0.5" flex="1" minW="0" align="flex-start">
									<Text fontSize="14px" fontWeight="500" maxW="full" truncate>
										{account.displayName}
									</Text>
									<Text fontSize="12px" color="fg.muted" maxW="full" truncate>
										{account.handle ?? account.providerAccountId}
									</Text>
									{account.status !== "active" ? (
										<Box mt="1">
											<StatusPill tone="warning">
												<Text as="span" textTransform="capitalize">{account.status.replaceAll("_", " ")}</Text>
											</StatusPill>
										</Box>
									) : !SOCIAL_PROVIDER_CAPABILITIES[account.platform].publishingEnabled ? (
										<Box mt="1">
											<StatusPill>Publishing coming soon</StatusPill>
										</Box>
									) : !account.publishingEligible ? (
										<Text mt="1" fontSize="12px" color="warning.fg">
											Over your plan's {accountLimit}-account limit
										</Text>
									) : null}
								</Stack>
								{canManage ? (
									<Flex gap="1" align="center" flexShrink={0}>
										{account.status !== "active" ? (
											<Button variant="subtle" size="sm" asChild>
												{/* A plain anchor: starting OAuth writes state, so it must not be prefetched. */}
												<a href={connectHref(account.platform, returnTo)}><RefreshCw size={13} />Reconnect</a>
											</Button>
										) : null}
										<Button
											size="sm"
											variant="ghost"
											color="fg.muted"
											_hover={{ color: "danger.fg", bg: "bg.soft" }}
											aria-label={`Disconnect ${account.displayName}`}
											loading={disconnecting === account.id}
											disabled={isPending || disconnecting !== null}
											onClick={() => void disconnect(account)}
										>
											<Trash2 size={14} />
										</Button>
									</Flex>
								) : null}
							</Flex>
						))}
					</SimpleGrid>
				</Stack>
			) : null}
			<Stack gap="4">
				<Flex align={{ base: "flex-start", md: "flex-end" }} justify="space-between" gap="4" wrap="wrap">
					<Stack gap="1" maxW="560px">
						<Text as="h2" fontSize="16px" fontWeight="500">
							{accounts.length
								? "Add an account"
								: "Connect your first social account"}
						</Text>
						{canManage ? (
							<Text fontSize="13px" color="fg.muted">
								Sign in to the account you want to add in this browser, then pick its platform.
							</Text>
						) : (
							<AccessNote access={access} capability="social.manage" action="connect a social account" />
						)}
					</Stack>
					{accountLimit > 0 ? (
						// How many of the plan's account slots are in use.
						<Stack gap="1.5" minW="200px">
							<Flex justify="space-between" fontSize="12px" color="fg.muted" gap="3">
								<Text>Accounts on your plan</Text>
								<Text color="fg" fontVariantNumeric="tabular-nums">
									{Math.min(slotsUsed, accountLimit)} of {accountLimit}
								</Text>
							</Flex>
							<Box h="6px" borderRadius="full" bg="bg.soft" overflow="hidden">
								<Box h="full" borderRadius="full" bg={slotsUsed >= accountLimit ? "warning.solid" : "accent.solid"} style={{ width: `${Math.max(3, Math.min(100, (slotsUsed / accountLimit) * 100))}%` }} />
							</Box>
						</Stack>
					) : null}
				</Flex>
				{/* With no account slots at all, the page leads with an upgrade banner instead. */}
				{canManage && accountLimit > 0 ? (
					<PlanLimitNotice message={connectRequirement} upgrade={connectUpgrade} canManageBilling={canManageBilling} />
				) : null}
				<SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} gap="2">
					{platforms.map((platform) => {
						const enabled = SOCIAL_PROVIDER_CAPABILITIES[platform].publishingEnabled;
						const connected = accounts.filter((account) => account.platform === platform && account.status === "active").length;
						const content = (
							<Flex key="content" align="center" gap="3" p="3.5" minW="0" w="full" textAlign="start">
								<BrandTile brand={platform} />
								<Stack gap="0" flex="1" minW="0">
									<Text fontSize="14px" fontWeight="500">
										{platformLabels[platform]}
									</Text>
									<Text fontSize="12px" color={enabled ? "fg.muted" : "fg.subtle"} truncate>
										{!enabled ? "Publishing coming soon" : connected ? `${platformFormats[platform]} · ${connected} connected` : platformFormats[platform]}
									</Text>
								</Stack>
							</Flex>
						);
						const addMark = (
							<Flex key="add" boxSize="7" me="3.5" borderRadius="8px" bg="bg.soft" color="fg" align="center" justify="center" flexShrink={0} aria-hidden="true">
								<Plus size={16} />
							</Flex>
						);
						return mayConnect ? (
							<Flex
								key={platform}
								asChild
								align="center"
								bg="bg.subtle"
								borderRadius="12px"
								transition="background 120ms ease"
								_hover={{ bg: "bg.muted" }}
								_focusVisible={{
									outline: "2px solid",
									outlineColor: "accent.solid",
									outlineOffset: "3px",
								}}
							>
								<a
									href={connectHref(platform, returnTo)}
									aria-label={`Connect ${platformLabels[platform]} account${enabled ? "" : " (publishing coming soon)"}`}
								>
									{content}
									{addMark}
								</a>
							</Flex>
						) : canManage && connectUpgrade?.tier ? (
							// At the plan's account limit the tile explains the upgrade instead of greying out.
							<Flex
								key={platform}
								asChild
								align="center"
								bg="bg.subtle"
								borderRadius="12px"
								cursor="pointer"
								transition="background 120ms ease"
								_hover={{ bg: "bg.muted" }}
								_focusVisible={{
									outline: "2px solid",
									outlineColor: "accent.solid",
									outlineOffset: "3px",
								}}
							>
								<button
									type="button"
									aria-haspopup="dialog"
									aria-label={`Connect ${platformLabels[platform]} account (needs ${PLAN_CATALOG[connectUpgrade.tier].name})`}
									onClick={() => openUpgrade(connectUpgrade)}
								>
									{content}
									<Box me="3.5" flexShrink={0}><UpgradeGem label={`Needs ${PLAN_CATALOG[connectUpgrade.tier].name}`} /></Box>
								</button>
							</Flex>
						) : (
							<Flex
								key={platform}
								align="center"
								bg="bg.subtle"
								borderRadius="12px"
								color="fg.muted"
							>
								{content}
							</Flex>
						);
					})}
				</SimpleGrid>
			</Stack>
			{dialog}
		</Stack>
	);
}
