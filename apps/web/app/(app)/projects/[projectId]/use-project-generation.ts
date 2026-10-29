"use client";

import { type FormEvent, useRef, useState } from "react";
import { type Intent, isApiError } from "@narriflow/api-client";
import { clipCommands } from "@narriflow/api-client/clips";
import { invalidateAfterGeneration, projectCommands } from "@narriflow/api-client/projects";
import { useMutation } from "@tanstack/react-query";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { intentIn, requireClipApi, useClipApi } from "@/lib/clip-media";
import { apiFailureMessage, browserFailureFromApiError } from "@/lib/publishing-client";
import { readContentPackFromForm, readLanguageCodeFromForm } from "../../upload/_lib/content-pack-form";
import { useUpgrade } from "../../_components/upgrade";

/** Which stage a settings form starts: speech-to-text for a new source, or clip detection. */
export type GenerationKind = "transcription" | "detection";

/**
 * Submits a Project's processing settings form (the `AdvancedClipSettings`
 * hidden fields) to the generation command for `kind`. One Idempotency-Key per
 * submit: it is minted before the first attempt, kept through a lost response
 * or token refresh so the retry replays the same command, and dropped once the
 * API accepted it. Credit and plan refusals open the existing upgrade dialog
 * and show their message in place, instead of the old redirect to the page.
 */
export function useProjectGeneration(projectId: string, kind: GenerationKind) {
	const api = useClipApi();
	const { openUpgrade } = useUpgrade();
	const intent = useRef<Intent<unknown> | null>(null);
	const [error, setError] = useState<string | null>(null);

	const start = useMutation({
		retry: false,
		mutationFn: async (form: FormData) => {
			const { runtime, scope, queryClient, projects, clips } = requireClipApi(api);
			const contentPack = readContentPackFromForm(form);
			const current = intentIn(intent, runtime);
			if (kind === "transcription") {
				const input = { contentPack, forceRegenerate: false, languageCode: readLanguageCodeFromForm(form) };
				await projectCommands.generate(projects, projectId, input, current.keyFor(input));
			} else {
				const input = { contentPack };
				await clipCommands.regenerate(clips, projectId, input, current.keyFor(input));
			}
			current.complete();
			await invalidateAfterGeneration(queryClient, scope, projectId);
		},
		onMutate: () => setError(null),
		onError: (failure) => {
			const fallback = "Could not start processing. Please try again.";
			if (!isApiError(failure)) {
				// The settings did not form a valid content pack; nothing was sent.
				setError(fallback);
				return;
			}
			const prompt = upgradePromptFromFailure(browserFailureFromApiError(failure));
			if (prompt) openUpgrade(prompt);
			setError(apiFailureMessage(failure, fallback));
		},
	});

	return {
		pending: start.isPending,
		error,
		onSubmit(event: FormEvent<HTMLFormElement>) {
			event.preventDefault();
			if (start.isPending) return;
			start.mutate(new FormData(event.currentTarget));
		},
	};
}
