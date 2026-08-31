"use client";

import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
	generatedMediaDownloadResultSchema,
	generatedMediaStudioListResultSchema,
	type GeneratedMediaStudioListResult,
} from "@narriflow/validators";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePlaybackTime } from "../playback-clock";
import { useStudio } from "../studio-shell";
import type { GeneratedMediaInsertionIntent } from "./generated-media-actions";
import { GeneratedMediaPanel } from "./generated-media-panel";
import {
	buildGeneratedMediaPromptSources,
	revisionFenceGeneratedMediaStudioSubmit,
	shouldPollGeneratedMedia,
	type GeneratedMediaStudioSubmitDraft,
} from "./generated-media-studio-model";

type ApiFailure = { error?: unknown };

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function assertAccepted(response: Response): Promise<unknown> {
	const payload = await readJson(response);
	if (response.ok) return payload;
	const code = (payload as ApiFailure | null)?.error;
	const actionable = new Set([
		"generated_media_usage_exhausted",
		"generated_media_asset_in_use",
		"generated_media_brand_profile_unavailable",
		"generated_media_prompt_source_revision_conflict",
	]);
	throw new Error(
		typeof code === "string" && actionable.has(code)
			? code
			: "generated_media_request_failed",
	);
}

function downloadTransientAttachment(url: string) {
	const link = document.createElement("a");
	link.href = url;
	link.rel = "noopener";
	link.click();
}

export function GeneratedMediaStudioPanel() {
	const studio = useStudio();
	const playbackTime = usePlaybackTime(studio.playbackClock);
	const [result, setResult] = useState<GeneratedMediaStudioListResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);

	const refresh = useCallback(async () => {
		const query = new URLSearchParams({ clipId: studio.clipInfo.id, limit: "40" });
		const response = await fetch(
			`/api/projects/${studio.clipInfo.projectId}/generated-media/jobs?${query.toString()}`,
			{ cache: "no-store" },
		);
		const parsed = generatedMediaStudioListResultSchema.safeParse(
			await assertAccepted(response),
		);
		if (!parsed.success) throw new Error("generated_media_response_invalid");
		setResult(parsed.data);
		setLoadError(false);
	}, [studio.clipInfo.id, studio.clipInfo.projectId]);

	useEffect(() => {
		let active = true;
		void refresh()
			.catch(() => {
				if (active) setLoadError(true);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [refresh]);

	useEffect(() => {
		if (!result || !shouldPollGeneratedMedia(result.jobs)) return;
		const timer = window.setTimeout(() => {
			void refresh().catch(() => setLoadError(true));
		}, 3_000);
		return () => window.clearTimeout(timer);
	}, [refresh, result]);

	const promptSources = useMemo(
		() => buildGeneratedMediaPromptSources({
			clipId: studio.clipInfo.id,
			transcriptSelectionRange: studio.transcriptSelectionRange,
			utterances: studio.utterances,
			brollCues: studio.clipInfo.brollCues,
		}),
		[
			studio.clipInfo.brollCues,
			studio.clipInfo.id,
			studio.transcriptSelectionRange,
			studio.utterances,
		],
	);
	const basePlayheadSec = studio.compositeToBaseEdited(playbackTime);

	const mutate = useCallback(async (
		path: string,
		init: RequestInit,
	) => {
		const response = await fetch(
			`/api/projects/${studio.clipInfo.projectId}/generated-media${path}`,
			init,
		);
		return assertAccepted(response);
	}, [studio.clipInfo.projectId]);

	async function submit(input: GeneratedMediaStudioSubmitDraft) {
		const request = await revisionFenceGeneratedMediaStudioSubmit(
			input,
			studio.checkpointEditorRevision,
		);
		await mutate("/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
	}

	async function cancel(jobId: string) {
		await mutate(`/jobs/${jobId}/cancel`, { method: "POST" });
	}

	async function saveToBrand(jobId: string) {
		await mutate(`/jobs/${jobId}/brand-profile`, { method: "POST" });
	}

	async function deleteAsset(jobId: string) {
		await mutate(`/jobs/${jobId}/asset`, { method: "DELETE" });
	}

	async function insert(intent: GeneratedMediaInsertionIntent) {
		await studio.commitGeneratedMediaInsertion(intent);
		await refresh();
	}

	async function download(jobId: string) {
		const parsed = generatedMediaDownloadResultSchema.safeParse(
			await mutate(`/jobs/${jobId}/download`, { method: "GET" }),
		);
		if (!parsed.success) throw new Error("generated_media_asset_unavailable");
		downloadTransientAttachment(parsed.data.accessUrl);
	}

	if (loading && !result) {
		return (
			<Flex h="100%" align="center" justify="center" color="studio.fgMuted">
				<Spinner size="sm" />
			</Flex>
		);
	}

	if (!result) {
		return (
			<Stack h="100%" align="center" justify="center" px="5" gap="3">
				<AlertTriangle size={18} />
				<Text fontSize="12px" color="studio.fgMuted" textAlign="center">
					Generated media history is temporarily unavailable.
				</Text>
				<Button size="xs" variant="outline" onClick={() => void refresh()}>
					<RefreshCw size={12} /> Retry
				</Button>
			</Stack>
		);
	}

	return (
		<Box h="100%" overflowY="auto">
			{loadError && (
				<Flex role="alert" mx="4" mt="3" gap="2" color="danger.fg" align="center">
					<AlertTriangle size={12} />
					<Text fontSize="11px">Results may be out of date. Refresh to try again.</Text>
				</Flex>
			)}
			<GeneratedMediaPanel
				projectId={studio.clipInfo.projectId}
				clipId={studio.clipInfo.id}
				basePlayheadSec={basePlayheadSec}
				baseDurationSec={studio.editedTimeMap.editedDurationSec}
				compositePlayheadSec={playbackTime}
				compositeDurationSec={studio.duration}
				promptSources={promptSources}
				jobs={result.jobs}
				selectedBrollPlacementId={studio.selectedBrollPlacementId}
				activeBrandProfile={result.activeBrandProfile}
				usage={result.usage}
				imageAvailable={result.capabilities.imageAvailable}
				videoAvailable={result.capabilities.videoAvailable}
				supportedImageRatios={result.capabilities.supportedImageRatios}
				supportedVideoRatios={result.capabilities.supportedVideoRatios}
				supportedVideoDurations={result.capabilities.supportedVideoDurations}
				onGenerate={submit}
				onRefresh={refresh}
				onCancel={cancel}
				onInsert={insert}
				onSaveToBrand={saveToBrand}
				onDownload={download}
				onDelete={deleteAsset}
			/>
		</Box>
	);
}
