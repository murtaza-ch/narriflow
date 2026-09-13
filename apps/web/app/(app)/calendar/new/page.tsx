import Link from "next/link";
import { Stack, Text, Box, Flex } from "@chakra-ui/react";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService } from "@narriflow/services";
export default async function NewCalendarPostPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
	const actor = await admitWorkspacePage("publishing.manage");
	const params = await searchParams;
	const { clips, nextCursor } = await workspaceLibraryService.getCalendarComposerOptions(
		actor.actorUserId,
		actor.workspaceId,
		{ query: params.q, cursor: params.cursor },
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
			<form method="get"><Input name="q" aria-label="Search clips or projects" defaultValue={params.q} placeholder="Search clips or projects" /><Button type="submit" size="sm" mt="2">Search</Button></form>
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
					{params.q ? "No clips match your search." : "Create a project and a clip to schedule your first post."}
				</Text>
			)}
			{(params.cursor || nextCursor) && <Flex gap="2">{params.cursor && <Button size="sm" variant="outline" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}`}>Newest clips</Link></Button>}{nextCursor && <Button size="sm" variant="outline" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}&cursor=${encodeURIComponent(nextCursor)}`}>Next</Link></Button>}</Flex>}
		</Stack>
	);
}
