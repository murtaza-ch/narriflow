"use client";

import { AUDIO_UPLOAD_MAX_BYTES, audioUploadContentTypeSchema, type AudioAssetKindInput } from "@narriflow/validators";

export const AUDIO_UPLOAD_ACCEPT = ".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a";
export const AUDIO_UPLOAD_MAX_MB = Math.floor(AUDIO_UPLOAD_MAX_BYTES / (1024 * 1024));

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

/** Browsers are inconsistent about `File.type` for audio (empty string for
 *  some .m4a files, "audio/x-m4a" vs "audio/mp4" for others) — fall back to
 *  the extension when the reported type isn't one the server accepts. */
function resolveContentType(file: File): string | null {
  const reportedType = audioUploadContentTypeSchema.safeParse(file.type);
  if (reportedType.success) return reportedType.data;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? EXTENSION_CONTENT_TYPE[ext] ?? null : null;
}

// L4: some files never fire EITHER `loadedmetadata` or `error` on a
// throwaway <audio> element (observed with a handful of oddly-muxed M4A
// files) — without a bound, the upload would await this forever.
const READ_AUDIO_DURATION_TIMEOUT_MS = 15_000;

/** Reads duration client-side via a throwaway `<audio>` element rather than
 *  sending the file to the server just to probe it. */
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      clearTimeout(timeoutId);
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Couldn't read this file's duration."));
    }, READ_AUDIO_DURATION_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      cleanup();
    });
    audio.addEventListener("error", () => {
      resolve(0);
      cleanup();
    });
  });
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

/** Uploads one file into the owner's audio library and returns the new asset.
 *  Throws an Error whose message is user-facing copy. */
export async function uploadAudioFile(file: File, kind: AudioAssetKindInput): Promise<{ id: string }> {
  if (file.size > AUDIO_UPLOAD_MAX_BYTES) {
    throw new Error(`Audio uploads are capped at ${AUDIO_UPLOAD_MAX_MB}MB.`);
  }
  const contentType = resolveContentType(file);
  if (!contentType) throw new Error("Upload an MP3, WAV, or M4A file.");

  const durationSec = await readAudioDuration(file);
  const presignRes = await fetch("/api/audio-assets/presign-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType, sizeBytes: file.size }),
  });
  if (!presignRes.ok) {
    const body = await presignRes.json().catch(() => ({}));
    throw new Error(body.message ?? "Couldn't start the upload.");
  }
  const { key, uploadUrl, contentType: signedContentType } = (await presignRes.json()) as {
    key: string;
    uploadUrl: string;
    contentType: string;
  };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": signedContentType },
    body: file,
  });
  if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

  const finalizeRes = await fetch("/api/audio-assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      kind,
      title: stripExtension(file.name).slice(0, 120) || "Untitled",
      durationSec,
      sizeBytes: file.size,
    }),
  });
  if (!finalizeRes.ok) {
    const body = await finalizeRes.json().catch(() => ({}));
    throw new Error(body.message ?? "Couldn't save the upload.");
  }
  return (await finalizeRes.json()) as { id: string };
}
