"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { Box, Stack } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { invalidatePublishing } from "@narriflow/api-client/publishing";
import { planCountRequirement, planLimits, planUpgradeHighlight } from "@narriflow/validators";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { publishingApi, publishingQueries } from "@/lib/publishing-client";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import { UpgradeHero } from "../../_components/upgrade";
import { SocialVisual } from "../../_components/upgrade-visuals";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { PageHeader } from "@narriflow/ui/components/page-header";
import SocialAccountsLoading from "./loading";
import { SocialAccountsPanel, type SocialAccountsApi } from "./social-accounts-panel";

/** A project's publishing draft is the only place an OAuth return may send the person back to. */
const RETURN_TO = /^\/projects\/[0-9a-f-]+\?publishClips=[0-9a-f,-]+$/;

/** Social accounts for the selected Workspace; the OAuth callback's notices arrive as query parameters. */
export function SocialAccountsScreen() {
	const scope = useWorkspaceScope();
	if (!scope) return <SocialAccountsLoading />;
	return <SocialAccountsContent key={scope.workspaceId} scope={scope} />;
}

function SocialAccountsContent({ scope }: { scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const queryClient = useQueryClient();
	const search = useSearchParams();
	const accountsQuery = useQuery(publishingQueries.accounts(runtime, scope));
	const bootstrap = useWorkspaceBootstrap(scope);

	const api = useMemo<SocialAccountsApi>(
		() => ({
			async startConnect(platform, redirect) {
				const started = await publishingApi(runtime.transport, scope).commands.startSocialOAuth(platform, redirect);
				return started.authorizationUrl;
			},
			async facebookPages(token, signal) {
				const { client } = publishingApi(runtime.transport, scope, signal);
				const response = await client.social.oauth["facebook-selection"][":token"].$get({ param: { token } });
				return (await response.json()).pages;
			},
			async selectFacebookPage(token, pageId) {
				const { client } = publishingApi(runtime.transport, scope);
				const response = await client.social.oauth["facebook-selection"][":token"].$post({ param: { token }, json: { pageId } });
				return (await response.json()).account;
			},
			disconnect: (accountId) => publishingApi(runtime.transport, scope).commands.disconnectAccount(accountId),
			onChanged: () => void invalidatePublishing(queryClient, scope),
			navigate: (url) => window.location.assign(url),
		}),
		[runtime.transport, scope, queryClient],
	);

	const error = accountsQuery.error ?? bootstrap.error;
	if (error) {
		return (
			<PublishingLoadError
				error={error}
				title="Social accounts"
				description="The accounts Narriflow publishes your clips to."
				what="Your social accounts"
				onRetry={() => {
					void accountsQuery.refetch();
					void bootstrap.refetch();
				}}
			/>
		);
	}
	if (!accountsQuery.data || !bootstrap.data) return <SocialAccountsLoading />;
	const accounts = accountsQuery.data.accounts;
	const { workspace, capabilities } = bootstrap.data;

	// Every account that isn't revoked holds a slot; reconnecting one is free.
	const slotsUsed = accounts.filter((account) => account.status !== "revoked").length;
	const accountLimit = planLimits(workspace.pricingTier).socialDestinations;
	const connectRequirement = planCountRequirement(workspace.pricingTier, "socialDestinations", slotsUsed);
	const canManageBilling = capabilities["billing.manage"];
	const requestedReturn = search.get("returnTo");
	const returnTo = requestedReturn && RETURN_TO.test(requestedReturn) ? requestedReturn : undefined;
	const connected = search.get("connected");
	return (
		<Stack gap="8">
			<Box animation="fade-up" animationFillMode="backwards">
				<PageHeader
					title="Social accounts"
					description="The accounts Narriflow publishes your clips to."
					actions={
						returnTo ? (
							<Button variant="subtle" asChild>
								<Link href={returnTo}>Back to publishing draft</Link>
							</Button>
						) : undefined
					}
				/>
			</Box>
			{accountLimit === 0 ? (
				<UpgradeHero
					title="Publish straight to your socials"
					points={["Connect TikTok, YouTube, Instagram, LinkedIn, Facebook, and X.", "Schedule clips from your calendar with AI-written captions."]}
					ctaLabel="Upgrade to connect accounts"
					visual={<SocialVisual />}
					prompt={{
						tier: connectRequirement?.requiredTier ?? null,
						headline: "Upgrade to publish to your socials",
						highlight: connectRequirement?.requiredTier ? planUpgradeHighlight(connectRequirement.requiredTier, "socialDestinations") : undefined,
						canManageBilling,
					}}
				/>
			) : null}
			<Box
				animation="fade-up"
				animationFillMode="backwards"
				style={{ animationDelay: "60ms" }}
			>
				<SocialAccountsPanel
					accounts={accounts}
					api={api}
					returnTo={returnTo}
					connectedCount={connected ? Number(connected) : null}
					errorCode={search.get("error")}
					facebookSelectionToken={search.get("facebook_selection")}
					// The capability connecting and disconnecting admit with (active owners and admins).
					canManage={capabilities["social.manage"]}
					access={{ role: workspace.role, status: workspace.status }}
					accountLimit={accountLimit}
					connectRequirement={connectRequirement?.message ?? null}
					connectUpgrade={
						connectRequirement?.requiredTier
							? {
									tier: connectRequirement.requiredTier,
									headline: "Upgrade to connect more accounts",
									highlight: planUpgradeHighlight(connectRequirement.requiredTier, "socialDestinations"),
								}
							: null
					}
					canManageBilling={canManageBilling}
				/>
			</Box>
		</Stack>
	);
}
