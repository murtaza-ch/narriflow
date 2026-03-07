"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, HStack, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Progress } from "@narriflow/ui/components/progress";

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
    <Stack gap="6" borderWidth="1px" borderColor="border" rounded="xl" p="6">
      <SimpleGrid columns={{ base: 1, sm: 3 }} gap="2">
        {([
          ["file", "File Upload"],
          ["youtube", "YouTube URL"],
          ["rss", "RSS Feed"],
        ] as const).map(([tabId, label]) => (
          <Button
            key={tabId}
            variant={activeTab === tabId ? "solid" : "outline"}
            size="sm"
            onClick={() => setActiveTab(tabId)}
            type="button"
            textAlign="left"
          >
            {label}
          </Button>
        ))}
      </SimpleGrid>

      <Stack gap="2">
        <label htmlFor="upload-title">
          <Text textStyle="sm" fontWeight="medium">Project title</Text>
        </label>
        <Input
          id="upload-title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Episode 45 - Founder interview"
          value={title}
        />
      </Stack>

      {activeTab === "file" ? (
        <Stack gap="4">
          <Input
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
          {uploading || progress > 0 ? <Progress value={progress} /> : null}
          {uploadMessage ? <Text textStyle="sm" color="fg.muted">{uploadMessage}</Text> : null}
          <HStack wrap="wrap" gap="2">
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
          </HStack>
        </Stack>
      ) : null}

      {activeTab === "youtube" ? (
        <Stack gap="4">
          <Input
            onChange={(event) => setYoutubeUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            type="url"
            value={youtubeUrl}
          />
          {youtubeMessage ? <Text textStyle="sm" color="fg.muted">{youtubeMessage}</Text> : null}
          <Button disabled={youtubeLoading} onClick={handleYoutubeImport} type="button">
            {youtubeLoading ? "Queueing..." : "Import YouTube Video"}
          </Button>
        </Stack>
      ) : null}

      {activeTab === "rss" ? (
        <Stack gap="4">
          <Input
            onChange={(event) => setRssUrl(event.target.value)}
            placeholder="https://example.com/feed.xml"
            type="url"
            value={rssUrl}
          />
          <HStack wrap="wrap" gap="2">
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
          </HStack>
          {rssMessage ? <Text textStyle="sm" color="fg.muted">{rssMessage}</Text> : null}
          {rssEpisodes.length > 0 ? (
            <Stack
              as="ul"
              gap="2"
              borderWidth="1px"
              borderColor="border"
              rounded="md"
              p="3"
              listStyleType="none"
            >
              {rssEpisodes.map((episode) => (
                <Flex as="li" key={episode.id} align="start" gap="3" textStyle="sm">
                  <input
                    type="checkbox"
                    checked={selectedEpisodeIds.includes(episode.id)}
                    style={{ marginTop: "4px" }}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      toggleEpisode(episode.id, event.target.checked)
                    }
                  />
                  <Box>
                    <Text fontWeight="medium">{episode.title}</Text>
                    <Text textStyle="xs" color="fg.muted">
                      {episode.publishedAt ?? "Unknown publish date"}
                    </Text>
                  </Box>
                </Flex>
              ))}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
