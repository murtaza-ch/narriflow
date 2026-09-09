import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Box, Stack } from "@chakra-ui/react";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { socialOAuthService } from "@narriflow/services";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { SocialAccountsPanel } from "./social-accounts-panel";

export default async function SocialAccountsPage({
	searchParams,
}: {
	searchParams: Promise<{
		connected?: string;
		error?: string;
		facebook_selection?: string;
		returnTo?: string;
	}>;
}) {
	const appUser = await admitWorkspacePage("content.view");
	const [accounts, params] = await Promise.all([
		socialOAuthService.listAccounts(
			appUser.workspaceOwnerUserId,
			appUser.workspaceId,
		),
		searchParams,
	]);

	const returnTo =
		params.returnTo &&
		/^\/projects\/[0-9a-f-]+\?publishClips=[0-9a-f,-]+$/.test(params.returnTo)
			? params.returnTo
			: undefined;
	return (
		<Stack gap="8">
			<Box animation="fade-up" animationFillMode="backwards">
				<PageHeader
					title="Social accounts"
					actions={
						returnTo ? (
							<Button variant="outline" asChild>
								<Link href={returnTo}>Back to publishing draft</Link>
							</Button>
						) : undefined
					}
				/>
			</Box>
			<Box
				animation="fade-up"
				animationFillMode="backwards"
				style={{ animationDelay: "60ms" }}
			>
				<SocialAccountsPanel
					accounts={accounts}
					returnTo={returnTo}
					connectedCount={params.connected ? Number(params.connected) : null}
					errorCode={params.error ?? null}
					facebookSelectionToken={params.facebook_selection ?? null}
					canManage={
						appUser.workspace.role === "owner" ||
						appUser.workspace.role === "admin"
					}
				/>
			</Box>
		</Stack>
	);
}
