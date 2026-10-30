"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Film } from "lucide-react";
import { Stack, Text, Box, Flex } from "@chakra-ui/react";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { WorkspaceScope } from "@narriflow/api-client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { publishingQueries } from "@/lib/publishing-client";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import ChooseClipLoading from "./loading";

/** Choose a clip to schedule: search and cursor live in the URL, the options are one scoped read. */
export function ChooseClipScreen() {
	const scope = useWorkspaceScope();
	if (!scope) return <ChooseClipLoading />;
	return <ChooseClipContent key={scope.workspaceId} scope={scope} />;
}

function ChooseClipContent({ scope }: { scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const search = useSearchParams();
	const params = { q: search.get("q") ?? undefined, cursor: search.get("cursor") ?? undefined };
	const options = useQuery({
		...publishingQueries.composerOptions(runtime, scope, {
			...(params.q ? { q: params.q } : {}),
			...(params.cursor ? { cursor: params.cursor } : {}),
		}),
		placeholderData: keepPreviousData,
	});
	if (options.error) {
		return (
			<PublishingLoadError
				error={options.error}
				title="Choose a clip"
				what="Your clips"
				from="calendar"
				onRetry={() => void options.refetch()}
			/>
		);
	}
	if (!options.data) return <ChooseClipLoading />;
	const { clips, nextCursor } = options.data;
	return (
		<Stack gap="6" maxW="760px" mx="auto" w="full">
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
					description={params.q ? undefined : "Import a video and generate clips to schedule your first post."}
					action={
						params.q ? undefined : (
							<Button asChild>
								<Link href="/upload">Import a video</Link>
							</Button>
						)
					}
				/>
			)}
			{(params.cursor || nextCursor) && <Flex gap="2">{params.cursor && <Button size="sm" variant="subtle" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}`}>Newest clips</Link></Button>}{nextCursor && <Button size="sm" variant="subtle" asChild><Link href={`/calendar/new?q=${encodeURIComponent(params.q ?? "")}&cursor=${encodeURIComponent(nextCursor)}`}>Next</Link></Button>}</Flex>}
		</Stack>
	);
}
