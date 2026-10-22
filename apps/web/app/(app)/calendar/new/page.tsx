import Link from "next/link";
import { Film } from "lucide-react";
import { Stack, Text, Box, Flex } from "@chakra-ui/react";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService } from "@narriflow/services";
import { EmptyState } from "@narriflow/ui/components/empty-state";
export default async function NewCalendarPostPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
	const actor = await admitWorkspacePage("publishing.manage");
	const params = await searchParams;
	const { clips, nextCursor } = await workspaceLibraryService.getCalendarComposerOptions(
		actor,
		{ query: params.q, cursor: params.cursor },
	);
	return (
		<Stack gap="6" maxW="760px">
			<PageHeader
				title="Choose a clip"
				description="Open the publishing drawer to choose accounts, write a description, and schedule delivery."
				actions={
					<Button variant="subtle" asChild>
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
						bg="bg.panel"
						borderWidth="1px"
						borderColor="border.card"
						borderRadius="l3"
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
				<EmptyState
					icon={<Film />}
					title={params.q ? "No clips match your search" : "No clips to schedule yet"}
					description={params.q ? undefined : "Create a project and a clip to schedule your first post."}
				/>
			)}
			{(params.cursor || nextCursor) && <Flex gap="2">{params.cursor && <Button size="sm" variant="subtle" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}`}>Newest clips</Link></Button>}{nextCursor && <Button size="sm" variant="subtle" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}&cursor=${encodeURIComponent(nextCursor)}`}>Next</Link></Button>}</Flex>}
		</Stack>
	);
}
