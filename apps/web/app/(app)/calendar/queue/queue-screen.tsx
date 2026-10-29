"use client";

import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft } from "lucide-react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { invalidateAfterProposalChange } from "@narriflow/api-client/publishing";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { publishingApi, publishingQueries } from "@/lib/publishing-client";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { useWorkspaceBootstrap } from "../../_components/usage";
import QueueLoading from "./loading";
import { PostingScheduleEditor, type PostingScheduleApi } from "./posting-schedule-editor";
import { ProposalsInbox, type ProposalsApi } from "./proposals-inbox";
import { Chip, QueueEmpty } from "./queue-parts";

function SectionTitle({ count, children }: { count?: number; children: React.ReactNode }) {
	return (
		<Flex align="center" gap="2" mb="3">
			<Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
				{children}
			</Text>
			{count ? <Chip>{count}</Chip> : null}
		</Flex>
	);
}

/** Three platforms as round marks: what an account connects to. */
function PlatformStack() {
	return (
		<Flex gap="2">
			{(["tiktok", "youtube_shorts", "instagram_reels"] as const).map((platform) => (
				<Flex key={platform} boxSize="11" align="center" justify="center" borderRadius="full" bg="bg.panel">
					<SocialPlatformMark platform={platform} />
				</Flex>
			))}
		</Flex>
	);
}

/** The publishing queue for the selected Workspace: proposals, accounts and the time zone arrive as one read. */
export function QueueScreen() {
	const scope = useWorkspaceScope();
	if (!scope) return <QueueLoading />;
	return <QueueContent key={scope.workspaceId} scope={scope} />;
}

function QueueContent({ scope }: { scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const queryClient = useQueryClient();
	const queue = useQuery(publishingQueries.queue(runtime, scope));
	const bootstrap = useWorkspaceBootstrap(scope);

	const refresh = useMemo(() => () => void invalidateAfterProposalChange(queryClient, scope), [queryClient, scope]);
	const proposalsApi = useMemo<ProposalsApi>(() => {
		const { commands, reads } = publishingApi(runtime.transport, scope);
		return {
			tiktokOptions: (accountId) => reads.tiktokOptions(accountId),
			updateCaption: (proposalId, caption) => commands.updateProposalCaption(proposalId, caption),
			reject: (proposalId) => commands.rejectProposal(proposalId),
			accept: (proposalId, choices) => commands.acceptProposal(proposalId, choices),
			acceptAll: (after) => commands.acceptAllProposals(after),
			onChanged: refresh,
		};
	}, [runtime.transport, scope, refresh]);
	const scheduleApi = useMemo<PostingScheduleApi>(() => {
		const { commands } = publishingApi(runtime.transport, scope);
		return { save: (accountId, schedule) => commands.savePostingSchedule(accountId, schedule), onChanged: refresh };
	}, [runtime.transport, scope, refresh]);

	const error = queue.error ?? bootstrap.error;
	if (error) {
		return (
			<PublishingLoadError
				error={error}
				title="Publishing queue"
				description="Posting slots for each account, and the posts waiting for you to accept them into one."
				what="The publishing queue"
				onRetry={() => {
					void queue.refetch();
					void bootstrap.refetch();
				}}
			/>
		);
	}
	if (!queue.data || !bootstrap.data) return <QueueLoading />;
	const { proposals, accounts, timezone: timeZone, canManage, canConnect } = queue.data;
	// Posting slots and accepting into them need scheduling, which starts on Creator.
	const scheduleUpgrade = featureUpgradePrompt(bootstrap.data.workspace.pricingTier, "publishing.schedule", "Upgrade to schedule posts");

	return (
		<Stack gap="8">
			<PageHeader
				title="Publishing queue"
				description="Posting slots for each account, and the posts waiting for you to accept them into one."
				actions={
					<Button asChild size="sm" variant="ghost" color="fg.muted">
						<Link href="/calendar">
							<ArrowLeft size={14} />
							Calendar
						</Link>
					</Button>
				}
			/>
			<section>
				<SectionTitle count={proposals.length}>Proposed posts</SectionTitle>
				<ProposalsInbox proposals={proposals} api={proposalsApi} timeZone={timeZone} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
			</section>
			<section id="posting-schedule">
				<SectionTitle>Posting schedule</SectionTitle>
				{accounts.length === 0 ? (
					<QueueEmpty
						visual={<PlatformStack />}
						title="No connected accounts"
						description={
							canConnect
								? "Connect a social account, then give it weekly posting slots."
								: "Ask a workspace owner or admin to connect a social account."
						}
						action={
							canConnect ? (
								<Button asChild size="sm" flexShrink={0}>
									<Link href="/settings/social-accounts">Connect an account</Link>
								</Button>
							) : undefined
						}
					/>
				) : (
					<PostingScheduleEditor accounts={accounts} api={scheduleApi} timeZone={timeZone} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
				)}
			</section>
		</Stack>
	);
}
