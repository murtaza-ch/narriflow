import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft } from "lucide-react";
import { publishingQueue, socialOAuthService, workspaceService } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { PostingScheduleEditor } from "./posting-schedule-editor";
import { ProposalsInbox } from "./proposals-inbox";
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

export default async function PublishingQueuePage() {
	const appUser = await admitWorkspacePage("content.view");
	const [proposals, accounts, workspace] = await Promise.all([
		publishingQueue.listProposals(appUser),
		socialOAuthService.listAccounts(appUser),
		workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId),
	]);
	const timeZone = workspace?.timezone ?? "UTC";
	const canManage = workspaceAllowsCapability(appUser.workspace, "publishing.manage");
	// Owners and Admins connect accounts; everyone else is told whom to ask.
	const canConnect = workspaceAllowsCapability(appUser.workspace, "social.manage");
	// Posting slots and accepting into them need scheduling, which starts on Creator.
	const scheduleUpgrade = featureUpgradePrompt(appUser.workspace.pricingTier, "publishing.schedule", "Upgrade to schedule posts");

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
				<ProposalsInbox proposals={proposals} timeZone={timeZone} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
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
					<PostingScheduleEditor accounts={accounts} timeZone={timeZone} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
				)}
			</section>
		</Stack>
	);
}
