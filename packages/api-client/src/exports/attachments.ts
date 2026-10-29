import { apiErrorFromResponse } from "../core";
import type { ExportsClient } from "./index";

/**
 * Bounded text and archive downloads that must carry the session token, so the
 * body is fetched and the caller saves the Blob (create the object URL, click,
 * revoke it). Large media never comes through here: it goes to R2 through a
 * Download Grant.
 */
export const EXPORT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface ExportAttachment {
  blob: Blob;
  contentType: string;
  fileName: string;
}

export interface TimelineArchive extends ExportAttachment {
  /** The clip edit revision the archive was cut from (`X-Editor-Revision`), or null if absent. */
  editorRevision: number | null;
}

type TimelineFormat = Parameters<
  ExportsClient["projects"][":id"]["clips"][":clipId"]["timeline"][":format"]["$get"]
>[0]["param"]["format"];

function fileNameOf(response: Response, fallback: string): string {
  return /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? fallback;
}

const TOO_LARGE = "Attachment is too large to download in the browser";

/** Reads the body chunk by chunk and cancels it the moment it crosses the bound, whatever `Content-Length` claimed. */
async function readBoundedBlob(response: Response): Promise<Blob> {
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: response.headers.get("Content-Type") ?? "" });
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > EXPORT_ATTACHMENT_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new RangeError(TOO_LARGE);
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get("Content-Type") ?? "" });
}

async function readBounded(response: Response, fallbackName: string): Promise<ExportAttachment> {
  if (!response.ok) throw await apiErrorFromResponse(response);
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > EXPORT_ATTACHMENT_MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new RangeError(TOO_LARGE);
  }
  const blob = await readBoundedBlob(response);
  return {
    blob,
    contentType: response.headers.get("Content-Type") ?? blob.type,
    fileName: fileNameOf(response, fallbackName),
  };
}

/** SRT or VTT of one export, derived from its frozen snapshot. */
export async function fetchSubtitleFile(
  client: ExportsClient,
  projectId: string,
  clipId: string,
  exportId: string,
  format: "srt" | "vtt",
  signal?: AbortSignal,
): Promise<ExportAttachment> {
  const response = await client.projects[":id"].clips[":clipId"].exports[":exportId"].subtitles[":format"].$get(
    { param: { id: projectId, clipId, exportId, format } },
    signal ? { init: { signal } } : undefined,
  );
  return readBounded(response, `subtitles.${format}`);
}

/** The clip's current edit as an editor timeline plus its SRT, in one ZIP. */
export async function fetchTimelineArchive(
  client: ExportsClient,
  projectId: string,
  clipId: string,
  format: TimelineFormat,
  signal?: AbortSignal,
): Promise<TimelineArchive> {
  const response = await client.projects[":id"].clips[":clipId"].timeline[":format"].$get(
    { param: { id: projectId, clipId, format } },
    signal ? { init: { signal } } : undefined,
  );
  const attachment = await readBounded(response, "timeline.zip");
  const revision = Number(response.headers.get("X-Editor-Revision"));
  return { ...attachment, editorRevision: Number.isSafeInteger(revision) && revision >= 0 && response.headers.has("X-Editor-Revision") ? revision : null };
}
