import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { publishingQueue, socialOAuthService, workspaceService } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { PostingScheduleEditor } from "./posting-schedule-editor";
import { ProposalsInbox } from "./proposals-inbox";

function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted" mb="3">
			{children}
		</Text>
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
				<SectionTitle>Proposed posts</SectionTitle>
				<ProposalsInbox proposals={proposals} timeZone={timeZone} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
			</section>
			<section id="posting-schedule">
				<SectionTitle>Posting schedule</SectionTitle>
				{accounts.length === 0 ? (
					<EmptyState
						icon={<CalendarDays />}
						title="No connected accounts"
						description={
							canConnect
								? "Connect a social account, then give it weekly posting slots."
								: "Ask a workspace owner or admin to connect a social account."
						}
						action={
							canConnect ? (
								<Button asChild>
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
