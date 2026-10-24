import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { publishingQueue, socialOAuthService, workspaceService } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
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
	const canManage = appUser.workspace.status === "active" && appUser.workspace.role !== "viewer";

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
				<ProposalsInbox proposals={proposals} timeZone={timeZone} canManage={canManage} />
			</section>
			<section>
				<SectionTitle>Posting schedule</SectionTitle>
				{accounts.length === 0 ? (
					<EmptyState
						icon={<CalendarDays />}
						title="No connected accounts"
						description="Connect a social account in Settings, then give it weekly posting slots."
						action={
							<Button asChild>
								<Link href="/settings/social-accounts">Connect an account</Link>
							</Button>
						}
					/>
				) : (
					<PostingScheduleEditor accounts={accounts} timeZone={timeZone} canManage={canManage} />
				)}
			</section>
		</Stack>
	);
}
