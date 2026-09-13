import Link from "next/link";
import { Stack, Text, Box, Flex } from "@chakra-ui/react";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService } from "@narriflow/services";
export default async function NewCalendarPostPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
	const actor = await admitWorkspacePage("publishing.manage");
	const params = await searchParams;
	const page = Number.isFinite(Number(params.page))
		? Math.max(0, Math.floor(Number(params.page)))
		: 0;
	const { clips, hasMore } = await workspaceLibraryService.getCalendarComposerOptions(
		actor.actorUserId,
		actor.workspaceId,
		{ query: params.q, page },
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
			<form method="get"><Input name="q" defaultValue={params.q} placeholder="Search clips or projects" /><Button type="submit" size="sm" mt="2">Search</Button></form>
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
			{(page > 0 || hasMore) && <Flex gap="2"><Button size="sm" variant="outline" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}&page=${Math.max(0, page - 1)}`}>Previous</Link></Button>{hasMore && <Button size="sm" variant="outline" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}&page=${page + 1}`}>Next</Link></Button>}</Flex>}
		</Stack>
	);
}
