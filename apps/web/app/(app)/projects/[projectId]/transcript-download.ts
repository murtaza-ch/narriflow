import { apiErrorFromResponse } from "@narriflow/api-client";
import { EXPORT_ATTACHMENT_MAX_BYTES } from "@narriflow/api-client/exports";
import type { ProjectsClient } from "@narriflow/api-client/projects";

export type TranscriptFormat = "txt" | "srt" | "vtt";

export interface TranscriptFile {
	blob: Blob;
	fileName: string;
}

/**
 * The transcript as a text, SubRip or WebVTT file. An anchor cannot carry the
 * session token, so the bounded body is fetched with the Bearer transport and
 * the caller saves the Blob (`saveBlob`). The status is checked before the body
 * is read, so a refusal surfaces as the typed `ApiError`, never as a saved file.
 */
export async function fetchTranscriptFile(
	client: ProjectsClient,
	projectId: string,
	format: TranscriptFormat,
	signal?: AbortSignal,
): Promise<TranscriptFile> {
	// The route reads `format` from the query string without declaring a
	// validator, so its type shows only the path parameter.
	const args = { param: { id: projectId }, query: { format } } as { param: { id: string } };
	const response = await client.projects[":id"].transcript.export.$get(args, signal ? { init: { signal } } : undefined);
	if (!response.ok) throw await apiErrorFromResponse(response);
	const declared = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > EXPORT_ATTACHMENT_MAX_BYTES) {
		void response.body?.cancel().catch(() => undefined);
		throw new RangeError("The transcript is too large to download in the browser");
	}
	const blob = await response.blob();
	if (blob.size > EXPORT_ATTACHMENT_MAX_BYTES) {
		throw new RangeError("The transcript is too large to download in the browser");
	}
	return {
		blob,
		fileName: /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `transcript.${format}`,
	};
}

/** Saves a fetched file: a short-lived object URL on a temporary anchor, revoked right after. */
export function saveBlob(file: TranscriptFile): void {
	const url = URL.createObjectURL(file.blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = file.fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
