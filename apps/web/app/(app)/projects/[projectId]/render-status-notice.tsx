"use client";

import { useRef, useState } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import type { Intent } from "@narriflow/api-client";
import { clipMutationOptions, invalidateAfterClipChange, invalidateProjectClips } from "@narriflow/api-client/clips";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { requireClipApi, useClipApi } from "@/lib/clip-media";
import { clipActionErrorCopy, failureNeedsStateRefetch } from "./clip-action-error-copy";
import {
	type RenderStatus,
	renderFailureHeadline,
	renderFailureMessage,
	retryFailedRenders,
} from "./render-status";

/**
 * The Clips tab's one line about renders. A failed render never hides the
 * clips that exist: this names how many failed and why, with Retry for exactly
 * those; the failed rows carry their own mark. While renders run it says so,
 * and it is absent when nothing failed or runs.
 */
export function RenderStatusNotice({
	projectId,
	status,
	canEdit,
}: {
	projectId: string;
	status: RenderStatus;
	canEdit: boolean;
}) {
	const api = useClipApi();
	const [error, setError] = useState<string | null>(null);
	// One intent per failed group: a retry after a lost response replays the render that was accepted.
	const intents = useRef(new Map<string, Intent<unknown>>());
	const retry = useMutation({
		...clipMutationOptions,
		mutationFn: async () => {
			const { runtime, clips, scope, queryClient } = requireClipApi(api);
			try {
				await retryFailedRenders({
					clips,
					projectId,
					groups: status.groups,
					intents: intents.current,
					createIntent: () => runtime.createIntent<unknown>(),
				});
			} finally {
				// Some groups may have queued even when a later one failed: show the real state.
				await invalidateAfterClipChange(queryClient, scope, projectId);
			}
		},
		onError: (failure) => {
			setError(clipActionErrorCopy(failure, "Could not retry the renders. Please try again."));
			if (api && failureNeedsStateRefetch(failure)) void invalidateProjectClips(api.queryClient, api.scope, projectId);
		},
	});

	if (status.failedCount > 0) {
		return (
			<Stack gap="2">
				<Flex
					role="status"
					align="center"
					justify="space-between"
					gap="3"
					wrap="wrap"
					px="3.5"
					py="3"
					borderRadius="l2"
					bg="danger.subtle"
				>
					<Flex align="flex-start" gap="2.5" minW="0">
						<Flex mt="0.5" color="danger.fg" flexShrink={0}>
							<AlertTriangle size={14} aria-hidden />
						</Flex>
						<Stack gap="0.5" minW="0">
							<Text fontSize="14px" fontWeight="500" color="danger.fg">
								{renderFailureHeadline(status.failedCount)}
							</Text>
							<Text fontSize="13px" color="fg.muted" maxW="60ch">
								{renderFailureMessage(status.errorCode)}
							</Text>
						</Stack>
					</Flex>
					{canEdit ? (
						<Button
							type="button"
							size="sm"
							variant="subtle"
							flexShrink={0}
							disabled={retry.isPending}
							onClick={() => {
								setError(null);
								retry.mutate();
							}}
						>
							{retry.isPending ? <Spinner size="xs" borderTopColor="accent.fg" /> : null}
							<Text ms={retry.isPending ? "1" : "0"}>
								{status.failedCount === 1 ? "Retry render" : "Retry renders"}
							</Text>
						</Button>
					) : null}
				</Flex>
				{error ? (
					<Flex role="alert" align="center" gap="1.5" color="danger.fg">
						<AlertTriangle size={12} aria-hidden />
						<Text fontSize="xs">{error}</Text>
					</Flex>
				) : null}
			</Stack>
		);
	}

	if (status.inFlightCount > 0) {
		return (
			<Flex role="status" align="center" gap="2.5" px="3.5" py="2.5" borderRadius="l2" bg="bg.soft">
				<Spinner size="xs" />
				<Text fontSize="13px" color="fg.muted">
					{status.inFlightCount === 1 ? "Rendering 1 video" : `Rendering ${status.inFlightCount} videos`}. Safe to
					leave this page.
				</Text>
			</Flex>
		);
	}

	return null;
}
