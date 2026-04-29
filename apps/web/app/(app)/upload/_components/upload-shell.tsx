"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, HStack, Stack, Tabs, Text } from "@chakra-ui/react";
import { Upload, Video, Rss } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Progress } from "@narriflow/ui/components/progress";
import type {
  BrandTemplateSummary,
  ClipLengthPreset,
  GenerationMode,
} from "@narriflow/validators";
import { LanguageSelect } from "./language-select";
import { ModeTabs } from "./mode-tabs";
import { ProcessingTimeline } from "./processing-timeline";
import { ClipSettingsForm } from "./clip-settings-form";
import { VideoPreview } from "./video-preview";
import { RecommendationCard } from "./recommendation-card";
import { BrandTemplatePicker } from "./brand-template-picker";
import {
  generateFromUploadAction,
  generateFromYoutubeAction,
  generateFromRssAction,
} from "../actions";

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

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "file", label: "File", icon: <Upload size={14} /> },
  { id: "youtube", label: "YouTube URL", icon: <Video size={14} /> },
  { id: "rss", label: "RSS feed", icon: <Rss size={14} /> },
];

function getFileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function loadUploadSession(fingerprint: string): UploadSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
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

function buildFormData(input: {
  languageCode: string;
  mode: GenerationMode;
  clipLengthPreset: ClipLengthPreset;
  autoHook: boolean;
  specificMoments: string;
  processingStartSec: number;
  processingEndSec: number;
  brandTemplateId: string | null;
}) {
  const formData = new FormData();
  formData.set("languageCode", input.languageCode);
  formData.set("mode", input.mode);
  formData.set("clipLengthPreset", input.clipLengthPreset);
  if (input.autoHook) formData.set("autoHook", "on");
  formData.set("specificMoments", input.specificMoments);
  formData.set("processingStartSec", String(input.processingStartSec));
  formData.set("processingEndSec", String(input.processingEndSec));
  if (input.brandTemplateId) {
    formData.set("brandTemplateId", input.brandTemplateId);
  }
  // Defaults so the contentPack schema is happy:
  formData.set("clipCountTarget", "10");
  formData.set("toneConstraints", "concise, conversational");
  return formData;
}

interface UploadShellProps {
  brandTemplates: {
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  };
}

export function UploadShell({ brandTemplates }: UploadShellProps) {
  const router = useRouter();

  // Source state
  const [activeTab, setActiveTab] = useState<TabId>("file");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [rssEpisodes, setRssEpisodes] = useState<RssEpisode[]>([]);
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<string[]>([]);
  const [rssPreviewLoading, setRssPreviewLoading] = useState(false);
  const [rssMessage, setRssMessage] = useState<string | null>(null);

  // Settings state
  const [languageCode, setLanguageCode] = useState("auto");
  const [mode, setMode] = useState<GenerationMode>("clip");
  const [clipLength, setClipLength] = useState<ClipLengthPreset>("auto");
  const [autoHook, setAutoHook] = useState(true);
  const [specificMoments, setSpecificMoments] = useState("");
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [brandTemplateId, setBrandTemplateId] = useState<string | null>(
    brandTemplates.defaultId,
  );

  // Submit / progress
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-fill title from filename / YouTube URL
  useEffect(() => {
    if (title.trim()) return;
    if (activeTab === "file" && file) {
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
    }
  }, [activeTab, file, title]);

  const selectedEpisodes = useMemo(
    () => rssEpisodes.filter((e) => selectedEpisodeIds.includes(e.id)),
    [rssEpisodes, selectedEpisodeIds],
  );

  const previewSource = useMemo(() => {
    if (activeTab === "file" && file) {
      return { kind: "file" as const, file };
    }
    if (activeTab === "youtube" && youtubeUrl.trim()) {
      return { kind: "youtube" as const, url: youtubeUrl.trim() };
    }
    if (activeTab === "rss" && selectedEpisodes.length > 0) {
      return {
        kind: "rss" as const,
        thumbnailUrl: null,
        title: selectedEpisodes[0]?.title ?? null,
        durationSeconds: selectedEpisodes[0]?.durationSeconds ?? null,
      };
    }
    return null;
  }, [activeTab, file, youtubeUrl, selectedEpisodes]);

  // Reset detected duration whenever the source identity changes so a new file
  // / YouTube URL / RSS episode triggers fresh detection.
  const sourceIdentity = useMemo(() => {
    if (!previewSource) return "";
    if (previewSource.kind === "file") {
      return `file:${previewSource.file.name}:${previewSource.file.size}:${previewSource.file.lastModified}`;
    }
    if (previewSource.kind === "youtube") return `yt:${previewSource.url}`;
    return `rss:${selectedEpisodes[0]?.id ?? ""}`;
  }, [previewSource, selectedEpisodes]);

  useEffect(() => {
    setDurationSec(null);
    setStartSec(0);
    setEndSec(0);
  }, [sourceIdentity]);

  function handleDurationKnown(seconds: number) {
    setDurationSec((prev) => {
      if (prev === seconds) return prev;
      setStartSec(0);
      setEndSec(seconds);
      return seconds;
    });
  }

  const hasSource =
    (activeTab === "file" && file) ||
    (activeTab === "youtube" && youtubeUrl.trim().length > 0) ||
    (activeTab === "rss" && selectedEpisodes.length > 0);

  const submitDisabled =
    submitting || !hasSource || !title.trim();

  function getFormValues() {
    return {
      languageCode,
      mode,
      clipLengthPreset: clipLength,
      autoHook,
      specificMoments,
      processingStartSec: Math.max(0, Math.floor(startSec)),
      processingEndSec: Math.max(
        Math.floor(startSec) + 1,
        Math.floor(endSec || durationSec || startSec + 1),
      ),
      brandTemplateId,
    };
  }

  async function handleFileUploadAndGenerate() {
    if (!file || !title.trim()) {
      setStatusMessage("Add a title and choose a file.");
      return;
    }

    setSubmitting(true);
    setStatusMessage(null);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const fingerprint = getFileFingerprint(file);
      const existingSession = loadUploadSession(fingerprint);
      const partCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

      setStatusMessage("Preparing upload...");
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
          brandTemplateId,
        }),
      });

      const presignJson = (await presignRes.json()) as {
        error?: string;
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
        presignJson.alreadyUploadedParts.map((p) => [p.partNumber, p.etag]),
      );
      const uploadedSet = new Set(presignJson.alreadyUploadedPartNumbers);
      const urlMap = new Map<number, string>(
        presignJson.uploadUrls.map((p) => [p.partNumber, p.url]),
      );

      setStatusMessage("Uploading...");
      for (let partNumber = 1; partNumber <= presignJson.partCount; partNumber += 1) {
        if (uploadedSet.has(partNumber)) {
          setProgress(Math.round((partNumber / presignJson.partCount) * 100));
          continue;
        }
        const url = urlMap.get(partNumber);
        if (!url) throw new Error(`Missing upload URL for part ${partNumber}`);

        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);

        const putRes = await fetch(url, {
          method: "PUT",
          body: blob,
          signal: abortController.signal,
        });
        if (!putRes.ok) throw new Error(`Part ${partNumber} upload failed (${putRes.status})`);

        const etag = putRes.headers.get("ETag") ?? putRes.headers.get("etag");
        if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);

        etagMap.set(partNumber, etag.replaceAll('"', ""));
        setProgress(Math.round((partNumber / presignJson.partCount) * 100));
      }

      const etags = Array.from(etagMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, etag]) => ({ partNumber, etag }));

      // Persist the desired generation settings BEFORE finalizing the upload.
      // Once /uploads/complete returns, the worker can pick up the ingest job
      // immediately and auto-fire triggerGenerationIfPending — it must find the
      // draft ContentPack at that moment.
      setStatusMessage("Saving generation settings...");
      const formData = buildFormData(getFormValues());
      formData.set("projectId", presignJson.projectId);
      await generateFromUploadAction(formData);

      setStatusMessage("Finalizing upload...");
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
      const completeJson = (await completeRes.json()) as {
        error?: string;
        projectId?: string;
      };
      if (!completeRes.ok || !completeJson.projectId) {
        throw new Error(completeJson.error ?? "Failed to finalize upload.");
      }

      saveUploadSession(null);

      router.push(`/projects/${completeJson.projectId}`);
      router.refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("Upload canceled.");
      } else {
        setStatusMessage(error instanceof Error ? error.message : "Upload failed.");
      }
    } finally {
      setSubmitting(false);
      abortRef.current = null;
    }
  }

  async function handleYoutubeImportAndGenerate() {
    if (!youtubeUrl.trim()) {
      setStatusMessage("Paste a YouTube URL first.");
      return;
    }

    setSubmitting(true);
    setStatusMessage("Importing video and queueing generation...");

    try {
      const formData = buildFormData(getFormValues());
      formData.set("title", title.trim());
      formData.set("youtubeUrl", youtubeUrl.trim());
      const result = await generateFromYoutubeAction(formData);
      if (result?.projectId) {
        router.push(`/projects/${result.projectId}`);
        router.refresh();
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "YouTube import failed.");
    } finally {
      setSubmitting(false);
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
      const payload = (await response.json()) as {
        error?: string;
        episodes?: RssEpisode[];
      };
      if (!response.ok || !payload.episodes) {
        throw new Error(payload.error ?? "Could not load RSS episodes.");
      }
      setRssEpisodes(payload.episodes);
      setSelectedEpisodeIds(payload.episodes.slice(0, 1).map((e) => e.id));
      setRssMessage(`Found ${payload.episodes.length} episodes.`);
    } catch (error) {
      setRssMessage(error instanceof Error ? error.message : "Could not preview RSS feed.");
    } finally {
      setRssPreviewLoading(false);
    }
  }

  async function handleRssImportAndGenerate() {
    if (!rssUrl.trim() || selectedEpisodes.length === 0) {
      setStatusMessage("Select at least one episode to import.");
      return;
    }
    setSubmitting(true);
    setStatusMessage("Importing episode and queueing generation...");

    try {
      const formData = buildFormData(getFormValues());
      formData.set("rssUrl", rssUrl.trim());
      formData.set("titlePrefix", title.trim());
      formData.set("episodes", JSON.stringify(selectedEpisodes));
      const result = await generateFromRssAction(formData);
      if (result?.projectId) {
        router.push(`/projects/${result.projectId}`);
        router.refresh();
      } else {
        router.push("/projects");
        router.refresh();
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "RSS import failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleEpisode(episodeId: string, checked: boolean) {
    setSelectedEpisodeIds((current) => {
      if (checked) return [episodeId]; // single-select for v1; clip generation per-episode
      return current.filter((id) => id !== episodeId);
    });
  }

  function handleSubmit() {
    if (activeTab === "file") return handleFileUploadAndGenerate();
    if (activeTab === "youtube") return handleYoutubeImportAndGenerate();
    if (activeTab === "rss") return handleRssImportAndGenerate();
  }

  const submitLabel =
    mode === "caption_only"
      ? "Get captioned video in 1 click"
      : "Get clips in 1 click";

  return (
    <Grid templateColumns={{ base: "1fr", lg: "1.1fr 1fr" }} gap="24px">
      {/* LEFT — source picker + preview */}
      <Stack gap="20px">
        <Tabs.Root
          value={activeTab}
          onValueChange={(details) => setActiveTab(details.value as TabId)}
          variant="line"
          size="sm"
        >
          <Tabs.List>
            {tabs.map((tab) => (
              <Tabs.Trigger key={tab.id} value={tab.id}>
                <Flex align="center" gap="6px">
                  {tab.icon}
                  <Text>{tab.label}</Text>
                </Flex>
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="file" pt="16px">
            <Box
              as="label"
              display="block"
              borderRadius="14px"
              borderWidth="2px"
              borderStyle="dashed"
              borderColor={file ? "border.accent" : "border"}
              bg={file ? "accent.subtle" : "bg.subtle"}
              p="36px"
              textAlign="center"
              cursor="pointer"
              transition="all 150ms ease"
              _hover={{ borderColor: "border.accent" }}
            >
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  setDurationSec(null);
                  setStartSec(0);
                  setEndSec(0);
                }}
                style={{ display: "none" }}
              />
              <Flex direction="column" align="center" gap="6px">
                <Upload size={22} color="var(--chakra-colors-fg-muted)" />
                <Text fontSize="13px" fontWeight="500" color="fg">
                  {file ? file.name : "Drop video or click to browse"}
                </Text>
                <Text fontSize="11px" color="fg.subtle">
                  {file
                    ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
                    : "MP4, MOV, WebM, MKV, MP3, WAV — up to 5 GB"}
                </Text>
              </Flex>
            </Box>
          </Tabs.Content>

          <Tabs.Content value="youtube" pt="16px">
            <Stack gap="10px">
              <Input
                onChange={(event) => setYoutubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                type="url"
                value={youtubeUrl}
              />
              <Text fontSize="11px" color="fg.subtle">
                Public videos only. Make sure you have rights to clip the content.
              </Text>
            </Stack>
          </Tabs.Content>

          <Tabs.Content value="rss" pt="16px">
            <Stack gap="12px">
              <Flex gap="8px">
                <Input
                  onChange={(event) => setRssUrl(event.target.value)}
                  placeholder="https://example.com/feed.xml"
                  type="url"
                  value={rssUrl}
                />
                <Button
                  disabled={rssPreviewLoading}
                  onClick={handleRssPreview}
                  type="button"
                  variant="outline"
                  size="sm"
                >
                  {rssPreviewLoading ? "Loading..." : "Preview"}
                </Button>
              </Flex>
              {rssMessage && (
                <Text fontSize="12px" color="fg.muted">
                  {rssMessage}
                </Text>
              )}
              {rssEpisodes.length > 0 && (
                <Stack
                  gap="0"
                  borderRadius="10px"
                  borderWidth="1px"
                  borderColor="border"
                  overflow="hidden"
                  maxH="240px"
                  overflowY="auto"
                >
                  {rssEpisodes.map((episode, index) => (
                    <Flex
                      key={episode.id}
                      as="label"
                      align="center"
                      gap="10px"
                      px="14px"
                      py="10px"
                      fontSize="13px"
                      cursor="pointer"
                      borderBottomWidth={index < rssEpisodes.length - 1 ? "1px" : "0"}
                      borderColor="border"
                      bg={selectedEpisodeIds.includes(episode.id) ? "accent.subtle" : "transparent"}
                      transition="background 120ms ease"
                      _hover={{ bg: "bg.muted" }}
                    >
                      <input
                        type="radio"
                        name="rss-episode"
                        checked={selectedEpisodeIds.includes(episode.id)}
                        onChange={(event) => toggleEpisode(episode.id, event.target.checked)}
                      />
                      <Box overflow="hidden" flex="1">
                        <Text fontWeight="500" color="fg" truncate>
                          {episode.title}
                        </Text>
                        <Text fontSize="11px" color="fg.subtle" mt="1px">
                          {episode.publishedAt ?? "Unknown publish date"}
                        </Text>
                      </Box>
                    </Flex>
                  ))}
                </Stack>
              )}
            </Stack>
          </Tabs.Content>
        </Tabs.Root>

        {hasSource ? (
          <VideoPreview source={previewSource} onDurationKnown={handleDurationKnown} />
        ) : (
          <RecommendationCard />
        )}
      </Stack>

      {/* RIGHT — settings panel */}
      <Stack
        gap="18px"
        p="20px"
        borderRadius="14px"
        borderWidth="1px"
        borderColor="border"
        bg="bg"
        position={{ base: "static", lg: "sticky" }}
        top={{ lg: "24px" }}
        alignSelf="start"
      >
        <Box>
          <Text fontSize="13px" fontWeight="500" color="fg" mb="6px">
            Project title
          </Text>
          <Input
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Episode 45 — Founder interview"
            value={title}
          />
        </Box>

        <LanguageSelect value={languageCode} onChange={setLanguageCode} />

        <Box>
          <Text fontSize="13px" fontWeight="500" color="fg" mb="8px">
            Mode
          </Text>
          <ModeTabs value={mode} onChange={setMode} />
        </Box>

        <BrandTemplatePicker
          builtIns={brandTemplates.builtIns}
          mine={brandTemplates.mine}
          value={brandTemplateId}
          onChange={setBrandTemplateId}
        />

        {mode === "clip" && (
          <ClipSettingsForm
            clipLength={clipLength}
            onClipLengthChange={setClipLength}
            autoHook={autoHook}
            onAutoHookChange={setAutoHook}
            specificMoments={specificMoments}
            onSpecificMomentsChange={setSpecificMoments}
          />
        )}

        {mode === "caption_only" && (
          <Box
            p="12px"
            borderRadius="10px"
            bg="bg.subtle"
            borderWidth="1px"
            borderColor="border"
          >
            <Text fontSize="12px" color="fg.muted" lineHeight="1.5">
              We transcribe your full video, then render it at original length
              with burned-in captions. No clipping.
            </Text>
          </Box>
        )}

        <ProcessingTimeline
          durationSec={durationSec}
          startSec={startSec}
          endSec={endSec}
          disabled={!hasSource || !durationSec}
          hasSource={Boolean(hasSource)}
          onChange={(s, e) => {
            setStartSec(s);
            setEndSec(e);
          }}
        />

        {submitting && progress > 0 && <Progress value={progress} />}
        {statusMessage && (
          <Text fontSize="12px" color="fg.muted">
            {statusMessage}
          </Text>
        )}

        <HStack gap="8px">
          <Button
            disabled={submitDisabled}
            onClick={handleSubmit}
            type="button"
            size="md"
            flex="1"
          >
            {submitting ? "Working..." : submitLabel}
          </Button>
          {submitting && abortRef.current && (
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </Button>
          )}
        </HStack>

        <Text fontSize="11px" color="fg.subtle" textAlign="center">
          Using video you don&apos;t own may violate copyright laws.
        </Text>
      </Stack>
    </Grid>
  );
}
