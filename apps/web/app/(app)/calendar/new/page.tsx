import Link from "next/link";
import { Stack, Text, Box } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService } from "@narriflow/services";
export default async function NewCalendarPostPage() {
	const actor = await admitWorkspacePage("publishing.manage");
	const { clips } = await workspaceLibraryService.getCalendarComposerOptions(
		actor.actorUserId,
		actor.workspaceId,
	);
	return (
		<Stack gap="6" maxW="760px">
			<PageHeader
				title="Choose a clip"
				description="Open the publishing drawer to choose accounts, write a description, and schedule delivery."
				actions={
					<Button variant="outline" asChild>
						<Link href="/calendar">Back to Calendar</Link>
					</Button>
				}
			/>
			{clips.length ? (
				clips.map((clip) => (
					<Box
						key={clip.id}
						p="4"
						borderWidth="1px"
						borderColor="border"
						borderRadius="l2"
					>
						<Link href={`/projects/${clip.projectId}?publishClip=${clip.id}`}>
							<Text fontWeight="medium">{clip.title}</Text>
							<Text color="fg.muted" fontSize="xs">
								{clip.projectTitle}
							</Text>
						</Link>
					</Box>
				))
			) : (
				<Text color="fg.muted">
					Create a project and a clip to schedule your first post.
				</Text>
			)}
		</Stack>
	);
}
