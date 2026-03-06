"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Progress } from "@narriflow/ui/components/progress";
import { cn } from "@narriflow/ui/lib/utils";

type TabId = "file" | "youtube" | "rss";

const CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_STORAGE_KEY = "narriflow.upload.session.v1";

type RssEpisode = {
  id: string;
  title: string;
  enclosureUrl: string;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  mimeType?: string | null;
};

type UploadSession = {
  fingerprint: string;
  projectId: string;
  uploadId: string;
  key: string;
  fileName: string;
  title: string;
};

function getFileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function loadUploadSession(fingerprint: string): UploadSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as UploadSession;
    return parsed.fingerprint === fingerprint ? parsed : null;
  } catch {
    return null;
  }
}

function saveUploadSession(session: UploadSession | null) {
  if (!session) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function UploadWorkspace() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>("file");

  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadAbortController, setUploadAbortController] = useState<AbortController | null>(null);

  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [youtubeMessage, setYoutubeMessage] = useState<string | null>(null);

  const [rssUrl, setRssUrl] = useState("");
  const [rssPreviewLoading, setRssPreviewLoading] = useState(false);
  const [rssImportLoading, setRssImportLoading] = useState(false);
  const [rssMessage, setRssMessage] = useState<string | null>(null);
  const [rssEpisodes, setRssEpisodes] = useState<RssEpisode[]>([]);
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<string[]>([]);

  const selectedEpisodes = useMemo(
    () => rssEpisodes.filter((episode) => selectedEpisodeIds.includes(episode.id)),
    [rssEpisodes, selectedEpisodeIds],
  );

  async function handleFileUpload() {
    if (!file || !title.trim()) {
      setUploadMessage("Add a title and choose a file.");
      return;
    }

    setUploading(true);
    setUploadMessage(null);
    const abortController = new AbortController();
    setUploadAbortController(abortController);

    try {
      const fingerprint = getFileFingerprint(file);
      const existingSession = loadUploadSession(fingerprint);
      const partCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          title: title.trim(),
          fileName: file.name,
          fileSizeBytes: file.size,
          mimeType: file.type || "video/mp4",
          partCount,
          projectId: existingSession?.projectId,
          uploadId: existingSession?.uploadId,
        }),
      });

      const presignJson = (await presignRes.json()) as {
        error?: string;
        issues?: unknown;
        projectId: string;
        uploadId: string;
        key: string;
        partCount: number;
        uploadUrls: Array<{ partNumber: number; url: string }>;
        alreadyUploadedPartNumbers: number[];
        alreadyUploadedParts: Array<{ partNumber: number; etag: string }>;
      };

      if (!presignRes.ok) {
        throw new Error(presignJson.error ?? "Failed to initialize upload.");
      }

      saveUploadSession({
        fingerprint,
        projectId: presignJson.projectId,
        uploadId: presignJson.uploadId,
        key: presignJson.key,
        fileName: file.name,
        title: title.trim(),
      });

      const etagMap = new Map<number, string>(
        presignJson.alreadyUploadedParts.map((part) => [part.partNumber, part.etag]),
      );
      const uploadedSet = new Set(presignJson.alreadyUploadedPartNumbers);
      const urlMap = new Map<number, string>(presignJson.uploadUrls.map((part) => [part.partNumber, part.url]));

      for (let partNumber = 1; partNumber <= presignJson.partCount; partNumber += 1) {
        if (uploadedSet.has(partNumber)) {
          setProgress(Math.round((partNumber / presignJson.partCount) * 100));
          continue;
        }

        const url = urlMap.get(partNumber);
        if (!url) {
          throw new Error(`Missing upload URL for part ${partNumber}`);
        }

        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);

        const putRes = await fetch(url, {
          method: "PUT",
          body: blob,
          signal: abortController.signal,
        });

        if (!putRes.ok) {
          throw new Error(`Part ${partNumber} upload failed (${putRes.status})`);
        }

        const etag = putRes.headers.get("ETag") ?? putRes.headers.get("etag");
        if (!etag) {
          throw new Error(`Missing ETag for part ${partNumber}`);
        }

        etagMap.set(partNumber, etag.replaceAll('"', ""));
        setProgress(Math.round((partNumber / presignJson.partCount) * 100));
      }

      const etags = Array.from(etagMap.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([partNumber, etag]) => ({ partNumber, etag }));

      const completeRes = await fetch("/api/uploads/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          projectId: presignJson.projectId,
          uploadId: presignJson.uploadId,
          key: presignJson.key,
          etags,
        }),
      });

      const completeJson = (await completeRes.json()) as { error?: string; projectId?: string };
      if (!completeRes.ok || !completeJson.projectId) {
        throw new Error(completeJson.error ?? "Failed to finalize upload.");
      }

      saveUploadSession(null);
      setUploadMessage("Upload complete. Redirecting to project...");
      router.push(`/projects/${completeJson.projectId}`);
      router.refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadMessage("Upload canceled.");
      } else {
        setUploadMessage(error instanceof Error ? error.message : "Upload failed.");
      }
    } finally {
      setUploading(false);
      setUploadAbortController(null);
    }
  }

  async function handleYoutubeImport() {
    if (!youtubeUrl.trim()) {
      setYoutubeMessage("Paste a YouTube URL first.");
      return;
    }

    setYoutubeLoading(true);
    setYoutubeMessage(null);

    try {
      const response = await fetch("/api/ingest/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          youtubeUrl: youtubeUrl.trim(),
        }),
      });

      const payload = (await response.json()) as { error?: string; project?: { id: string } };

      if (!response.ok || !payload.project) {
        throw new Error(payload.error ?? "YouTube import failed.");
      }

      setYoutubeMessage("Import queued. Redirecting to project...");
      router.push(`/projects/${payload.project.id}`);
      router.refresh();
    } catch (error) {
      setYoutubeMessage(error instanceof Error ? error.message : "YouTube import failed.");
    } finally {
      setYoutubeLoading(false);
    }
  }

  async function handleRssPreview() {
    if (!rssUrl.trim()) {
      setRssMessage("Paste an RSS feed URL first.");
      return;
    }

    setRssPreviewLoading(true);
    setRssMessage(null);

    try {
      const response = await fetch("/api/ingest/rss/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssUrl: rssUrl.trim() }),
      });

      const payload = (await response.json()) as { error?: string; episodes?: RssEpisode[] };

      if (!response.ok || !payload.episodes) {
        throw new Error(payload.error ?? "Could not load RSS episodes.");
      }

      setRssEpisodes(payload.episodes);
      setSelectedEpisodeIds(payload.episodes.slice(0, 3).map((episode) => episode.id));
      setRssMessage(`Found ${payload.episodes.length} episodes.`);
    } catch (error) {
      setRssMessage(error instanceof Error ? error.message : "Could not preview RSS feed.");
    } finally {
      setRssPreviewLoading(false);
    }
  }

  async function handleRssImport() {
    if (!rssUrl.trim() || selectedEpisodes.length === 0) {
      setRssMessage("Select at least one episode to import.");
      return;
    }

    setRssImportLoading(true);
    setRssMessage(null);

    try {
      const response = await fetch("/api/ingest/rss/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rssUrl: rssUrl.trim(),
          episodes: selectedEpisodes,
          titlePrefix: title.trim() || undefined,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        count?: number;
        projects?: Array<{ project: { id: string } }>;
      };

      if (!response.ok || !payload.projects) {
        throw new Error(payload.error ?? "RSS import failed.");
      }

      if (payload.projects.length === 1) {
        router.push(`/projects/${payload.projects[0]!.project.id}`);
      } else {
        router.push("/projects");
      }
      router.refresh();
    } catch (error) {
      setRssMessage(error instanceof Error ? error.message : "RSS import failed.");
    } finally {
      setRssImportLoading(false);
    }
  }

  function toggleEpisode(episodeId: string, checked: boolean) {
    setSelectedEpisodeIds((current) => {
      if (checked) {
        return Array.from(new Set([...current, episodeId]));
      }

      return current.filter((id) => id !== episodeId);
    });
  }

  return (
    <div className="space-y-6 rounded-xl border border-border p-6">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([
          ["file", "File Upload"],
          ["youtube", "YouTube URL"],
          ["rss", "RSS Feed"],
        ] as const).map(([tabId, label]) => (
          <button
            key={tabId}
            className={cn(
              "rounded-md border px-3 py-2 text-left text-sm",
              activeTab === tabId
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground",
            )}
            onClick={() => setActiveTab(tabId)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="upload-title">
          Project title
        </label>
        <Input
          id="upload-title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Episode 45 - Founder interview"
          value={title}
        />
      </div>

      {activeTab === "file" ? (
        <div className="space-y-4">
          <Input
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
          {uploading || progress > 0 ? <Progress value={progress} /> : null}
          {uploadMessage ? <p className="text-sm text-muted-foreground">{uploadMessage}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={uploading || !file} onClick={handleFileUpload} type="button">
              {uploading ? "Uploading..." : "Start Upload"}
            </Button>
            <Button
              disabled={!uploading}
              onClick={() => uploadAbortController?.abort()}
              type="button"
              variant="outline"
            >
              Cancel Upload
            </Button>
          </div>
        </div>
      ) : null}

      {activeTab === "youtube" ? (
        <div className="space-y-4">
          <Input
            onChange={(event) => setYoutubeUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            type="url"
            value={youtubeUrl}
          />
          {youtubeMessage ? <p className="text-sm text-muted-foreground">{youtubeMessage}</p> : null}
          <Button disabled={youtubeLoading} onClick={handleYoutubeImport} type="button">
            {youtubeLoading ? "Queueing..." : "Import YouTube Video"}
          </Button>
        </div>
      ) : null}

      {activeTab === "rss" ? (
        <div className="space-y-4">
          <Input
            onChange={(event) => setRssUrl(event.target.value)}
            placeholder="https://example.com/feed.xml"
            type="url"
            value={rssUrl}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={rssPreviewLoading} onClick={handleRssPreview} type="button" variant="outline">
              {rssPreviewLoading ? "Loading feed..." : "Preview Episodes"}
            </Button>
            <Button
              disabled={rssImportLoading || selectedEpisodeIds.length === 0}
              onClick={handleRssImport}
              type="button"
            >
              {rssImportLoading ? "Importing..." : `Import Selected (${selectedEpisodeIds.length})`}
            </Button>
          </div>
          {rssMessage ? <p className="text-sm text-muted-foreground">{rssMessage}</p> : null}
          {rssEpisodes.length > 0 ? (
            <ul className="space-y-2 rounded-md border border-border p-3">
              {rssEpisodes.map((episode) => (
                <li key={episode.id} className="flex items-start gap-3 text-sm">
                  <input
                    checked={selectedEpisodeIds.includes(episode.id)}
                    className="mt-1"
                    onChange={(event) => toggleEpisode(episode.id, event.target.checked)}
                    type="checkbox"
                  />
                  <div>
                    <p className="font-medium">{episode.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {episode.publishedAt ?? "Unknown publish date"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
