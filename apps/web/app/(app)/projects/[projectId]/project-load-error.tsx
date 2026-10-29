"use client";

import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { describeApiFailure } from "@narriflow/api-client";
import { AlertTriangle } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";

/**
 * Where a refused Project read sends the person, as the server-side page
 * admission did. A Project in another Workspace offers the switch on the
 * explorer; a paused Workspace sends the owner to billing and anyone else to
 * the page outside the shell; a missing capability goes home. `null` means
 * the failure is not a redirect (missing Project, outage, unknown).
 */
export function projectGateDestination(error: unknown, projectId: string): string | null {
	const { kind, error: apiError } = describeApiFailure(error);
	if (kind === "workspace_mismatch") {
		const workspaceId = String(apiError.details?.workspaceId ?? "");
		const workspaceName = String(apiError.details?.workspaceName ?? "Workspace");
		return `/projects?requestFailure=active_workspace_mismatch&workspaceId=${encodeURIComponent(workspaceId)}&workspaceName=${encodeURIComponent(workspaceName)}&returnTo=${encodeURIComponent(`/projects/${projectId}`)}`;
	}
	const suffix = `?requestFailure=${encodeURIComponent(apiError.code)}&requestId=${encodeURIComponent(apiError.requestId ?? "")}`;
	if (kind === "workspace_restricted") {
		// A paused workspace: the owner goes to billing; other members go to a page
		// outside the app shell, because /home would refuse them again (a loop).
		return `${apiError.details?.ownerCanResolve === true ? "/settings/billing" : "/workspace-unavailable"}${suffix}`;
	}
	if (kind === "forbidden") return `/home${suffix}`;
	return null;
}

/**
 * Whether a failed re-read means the Project is no longer the person's to see: gone,
 * forbidden, or its Workspace restricted or elsewhere. Such an answer replaces data
 * already on screen; a transport failure or throttle keeps showing the last good read.
 */
export function projectAccessLost(error: unknown): boolean {
	const { kind } = describeApiFailure(error);
	return kind === "missing" || kind === "forbidden" || kind === "workspace_restricted" || kind === "workspace_mismatch";
}

/** The Project could not be read or rendered: try again, or go back to the list. */
export function ProjectLoadError({
	onRetry,
	supportId,
}: {
	onRetry: () => void;
	/** The API request ID or the render digest, for support. */
	supportId?: string | null;
}) {
	return (
		<Flex minH="60dvh" align="center" justify="center" p="6">
			<Stack gap="3" align="center" animation="fade-up" animationFillMode="backwards">
				<EmptyState
					icon={
						<Flex color="danger.fg">
							<AlertTriangle size={20} aria-hidden />
						</Flex>
					}
					title="We couldn't load this project"
					description="Try again. If loading still fails, contact support."
					action={<Button onClick={onRetry}>Try again</Button>}
				/>
				<Link href="/projects">
					<Text
						as="span"
						fontSize="xs"
						color="fg.muted"
						textDecoration="underline"
						textDecorationColor="border.emphasized"
						textUnderlineOffset="3px"
						transition="text-decoration-color 120ms ease"
						_hover={{ textDecorationColor: "fg" }}
					>
						Back to projects
					</Text>
				</Link>
				{supportId ? (
					<Text textStyle="data" fontSize="12px" color="fg.subtle">
						digest {supportId}
					</Text>
				) : null}
			</Stack>
		</Flex>
	);
}
