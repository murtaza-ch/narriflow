"use client";

import { describeApiFailure } from "@narriflow/api-client";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { type DeniedFrom, deniedFromParam } from "@/lib/request-failure-notice";

/**
 * Where a refused page read sends the person, as the server-side page admission
 * did: a paused Workspace goes to billing (owner) or the unavailable page, a
 * missing capability back home. Anything else stays on the page with a retry.
 */
function recoveryDestination(error: unknown, from: DeniedFrom | undefined): string | null {
	const { kind, error: apiError } = describeApiFailure(error);
	const suffix = `?requestFailure=${encodeURIComponent(apiError.code)}&requestId=${encodeURIComponent(apiError.requestId ?? "")}`;
	if (kind === "workspace_restricted") {
		return `${apiError.details?.ownerCanResolve === true ? "/settings/billing" : "/workspace-unavailable"}${suffix}`;
	}
	if (kind === "forbidden") return `/home${suffix}${deniedFromParam(from)}`;
	return null;
}

export function PublishingLoadError({
	error,
	title,
	description,
	what,
	from,
	onRetry,
}: {
	error: unknown;
	title: string;
	description?: string;
	/** What could not be loaded, for the sentence under the title. */
	what: string;
	/** The page that refused, so Home can say what the member could not do. */
	from?: DeniedFrom;
	onRetry(): void;
}) {
	const router = useRouter();
	const destination = recoveryDestination(error, from);
	useEffect(() => {
		if (destination) router.replace(destination);
	}, [destination, router]);
	if (destination) return null;
	const offline = describeApiFailure(error).kind === "offline";
	return (
		<Stack gap="4" role="alert" align="flex-start">
			<PageHeader title={title} description={description} />
			<Text fontSize="13px" color="fg.muted">
				{offline ? "You appear to be offline. Check your connection and try again." : `${what} could not be loaded.`}
			</Text>
			<Button size="sm" variant="subtle" onClick={onRetry}>
				Try again
			</Button>
		</Stack>
	);
}
