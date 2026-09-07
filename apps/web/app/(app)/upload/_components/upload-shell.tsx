"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, Grid, HStack, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Info, Upload, Link2, AudioLines } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Radio, RadioGroup } from "@narriflow/ui/components/radio";
import { toaster } from "@narriflow/ui/components/toaster";
import type {
  CaptionPresetId,
  BrandTemplateSummary,
  ClipLengthPreset,
  ClipPlatformTarget,
  GenerationMode,
  LinkProviderId,
} from "@narriflow/validators";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  detectLinkProvider,
  LINK_PROVIDERS,
} from "@narriflow/validators";
import { formatDate } from "@/lib/format";
import {
  authenticatedRequestFailureMessage,
  classifyAuthenticatedRequestFailure,
  type BrowserRequestFailure,
} from "@/lib/authenticated-request-browser";
import { LanguageSelect } from "./language-select";
import { ModeTabs } from "./mode-tabs";
import { ProcessingTimeline } from "../../_shared/processing-timeline";
import { ClipSettingsForm } from "./clip-settings-form";
import { CaptionPresetSelect } from "../../_shared/caption-preset-select";
import { VideoPreview } from "./video-preview";
import { RecommendationCard } from "./recommendation-card";
import { BrandTemplatePicker } from "./brand-template-picker";
import {
  focusUploadSessionStatusForPhase,
  UploadSessionSecondaryActions,
  UploadSessionStatusPanel,
} from "./upload-session-status";
import {
  buildUploadGenerationContext,
  buildUploadSettingsFormData,
} from "../_lib/content-pack-form";
import {
  safelyGetUploadResumeStorage,
} from "../_lib/upload-resume";
import { createUploadSessionBrowserAdapter } from "../_lib/upload-session-browser";
import { generateFromRssAction } from "../actions";
import {
  LinkImportFlow,
  type LinkResumeData,
  type UploadUsageSummary,
} from "./link-import-flow";

type TabId = "file" | "link" | "rss";
type PasteOverride = "auto" | "link" | "rss";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const RSS_EPISODE_PAGE_SIZE = 50;

const FILE_ACCEPT =
  "video/mp4,video/quicktime,video/webm,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac";

/** Human-readable labels for the supported providers, joined for hints. */
const LINK_PROVIDER_LABELS_JOINED = LINK_PROVIDERS.map((p) => p.label).join(" · ");

function linkProviderLabel(provider: LinkProviderId): string {
  return LINK_PROVIDERS.find((p) => p.id === provider)?.label ?? "Link";
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(value.trim());
}

type RssEpisode = {
  id: string;
  title: string;
  enclosureUrl: string;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  mimeType?: string | null;
};

/** Section band: eyebrow above a 1.5px ink top-rule, content below. */
function SettingsBand({
  eyebrow,
  children,
}: {
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <Box>
      {eyebrow && (
        <Text textStyle="eyebrow" color="fg.subtle" mb="2">
          {eyebrow}
        </Text>
      )}
      <Box layerStyle="band">{children}</Box>
    </Box>
  );
}

/** Failure notice: Labeled danger panel with an icon — never muted small text. */
function ErrorNotice({ message }: { message: string }) {
  return (
    <Flex
      role="alert"
      align="center"
      gap="2.5"
      px="3"
      py="2.5"
      bg="danger.subtle"
      borderWidth="1px"
      borderColor="danger.muted"
      borderRadius="l2"
      position="relative"
      overflow="hidden"
    >
      <Box color="danger.fg" flexShrink={0}>
        <AlertTriangle size={14} strokeWidth={2} />
      </Box>
      <Text fontSize="12.5px" fontWeight="500" color="danger.fg">
        {message}
      </Text>
    </Flex>
  );
}

interface UploadShellProps {
  brandTemplates: {
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  };
  brandProfiles: {
    items: Array<{
      id: string;
      name: string;
      defaultTemplateId: string | null;
      templates: Array<{ id: string; name: string }>;
    }>;
    defaultId: string | null;
  };
  /** Pre-fills the smart paste field (dashboard links to /upload?url=…). */
  initialUrl?: string | null;
  initialSource?: PasteOverride;
  initialMode?: GenerationMode;
  /** Present when the page mounted with `?project=<id>` — the link flow's
   *  Step 2 (Configure) resume, loaded and validated server-side. */
  resumeData: LinkResumeData | null;
  usageSummary: UploadUsageSummary;
}

export function UploadShell({
  brandTemplates,
  brandProfiles,
  initialUrl,
  initialSource = "auto",
  initialMode = "clip",
  resumeData,
  usageSummary,
}: UploadShellProps) {
  const router = useRouter();
  const uploadAdapter = useMemo(
    () =>
      createUploadSessionBrowserAdapter({
        storage: safelyGetUploadResumeStorage(() => window.localStorage),
        navigate(projectId) {
          router.push(`/projects/${projectId}`);
          router.refresh();
        },
      }),
    [router],
  );
  const uploadSnapshot = useSyncExternalStore(
    uploadAdapter.subscribe,
    uploadAdapter.snapshot,
    uploadAdapter.snapshot,
  );
  useEffect(() => () => uploadAdapter.dispose(), [uploadAdapter]);
  const confirmUploadUnload = uploadAdapter.shouldConfirmUnload();

  // A recognized ?url= commits straight to a chosen source; anything else pre-fills the paste field.
  const initialLinkProvider = initialUrl ? detectLinkProvider(initialUrl.trim()) : null;
  const initialLinkUrl = initialLinkProvider ? initialUrl!.trim() : "";

  // Source state
  const [activeTab, setActiveTab] = useState<TabId>(
    resumeData || initialLinkUrl ? "link" : "file",
  );
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [linkUrl, setLinkUrl] = useState(initialLinkUrl);
  const [linkProvider, setLinkProvider] = useState<LinkProviderId | null>(
    initialLinkProvider,
  );
  const [rssUrl, setRssUrl] = useState("");
  const [rssCommitted, setRssCommitted] = useState(false);
  const [rssEpisodes, setRssEpisodes] = useState<RssEpisode[]>([]);
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<string[]>([]);
  const [rssEpisodeQuery, setRssEpisodeQuery] = useState("");
  const [rssEpisodeLimit, setRssEpisodeLimit] = useState(RSS_EPISODE_PAGE_SIZE);
  const [rssPreviewLoading, setRssPreviewLoading] = useState(false);
  const [rssNotice, setRssNotice] = useState<string | null>(null);
  const [rssError, setRssError] = useState<string | null>(null);

  function recoverRssRequest(
    failure: BrowserRequestFailure,
    setMessage: (message: string) => void,
    fallback: string,
  ) {
    const recovery = classifyAuthenticatedRequestFailure(failure, "/upload");
    const message = authenticatedRequestFailureMessage(
      failure,
      "/upload",
      fallback,
    );
    setMessage(message);
    if (recovery.kind === "sign_in") {
      router.push(
        `/sign-in?redirect_url=${encodeURIComponent(recovery.returnDestination)}`,
      );
    } else if (recovery.kind === "billing") {
      router.push("/settings/billing");
    } else if (recovery.kind === "missing") {
      setRssEpisodes([]);
      setSelectedEpisodeIds([]);
    }
    return message;
  }

  // Smart paste field
  const [pasteValue, setPasteValue] = useState(initialUrl?.trim() ?? "");
  const [pasteOverride, setPasteOverride] = useState<PasteOverride>(initialSource);

  // Settings state
  const [languageCode, setLanguageCode] = useState("auto");
  const [mode, setMode] = useState<GenerationMode>(initialMode);
  const [clipLength, setClipLength] = useState<ClipLengthPreset>("auto");
  const [autoHook, setAutoHook] = useState(true);
  const [specificMoments, setSpecificMoments] = useState("");
  const [captionPreset, setCaptionPreset] = useState<CaptionPresetId>(
    BRAND_DEFAULT_CAPTION_PRESET_ID,
  );
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const defaultBrandProfile = brandProfiles.items.find(
    (profile) => profile.id === brandProfiles.defaultId,
  );
  const [brandTemplateId, setBrandTemplateId] = useState<string | null>(
    defaultBrandProfile
      ? defaultBrandProfile.defaultTemplateId
      : brandTemplates.defaultId,
  );
  const [brandProfileId, setBrandProfileId] = useState<string | null>(
    brandProfiles.defaultId,
  );
  const [platformTargets, setPlatformTargets] = useState<ClipPlatformTarget[]>([
    "tiktok",
    "youtube_shorts",
    "instagram_reels",
  ]);
  const [clipCountTarget, setClipCountTarget] = useState(10);
  const [autoRenderClips, setAutoRenderClips] = useState(false);
  const [toneConstraints, setToneConstraints] = useState(
    "concise, conversational",
  );

  // Submit / progress
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rssCommitTokenRef = useRef<string | null>(null);
  const uploadStatusRef = useRef<HTMLDivElement | null>(null);

  const uploadBusy = ["preparing", "uploading", "verifying", "queued"].includes(
    uploadSnapshot.phase,
  );
  const uploadSourceLocked = uploadSnapshot.phase !== "idle";
  const busy = submitting || uploadBusy;

  // Drag & drop state
  const [dropzoneDragOver, setDropzoneDragOver] = useState(false);
  const [pageDragActive, setPageDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  // Auto-fill title from filename
  useEffect(() => {
    if (title.trim()) return;
    if (activeTab === "file" && file) {
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
    }
  }, [activeTab, file, title]);

  useEffect(() => {
    focusUploadSessionStatusForPhase(
      uploadSnapshot.phase,
      uploadStatusRef.current,
    );
  }, [uploadSnapshot.phase]);

  useEffect(() => {
    if (!confirmUploadUnload) return;
    const confirmInterruptedTransfer = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmInterruptedTransfer);
    return () =>
      window.removeEventListener("beforeunload", confirmInterruptedTransfer);
  }, [confirmUploadUnload]);

  const selectedEpisodes = useMemo(
    () => rssEpisodes.filter((e) => selectedEpisodeIds.includes(e.id)),
    [rssEpisodes, selectedEpisodeIds],
  );
  const filteredRssEpisodes = useMemo(() => {
    const query = rssEpisodeQuery.trim().toLocaleLowerCase();
    if (!query) return rssEpisodes;
    return rssEpisodes.filter((episode) =>
      `${episode.title} ${episode.publishedAt ?? ""}`.toLocaleLowerCase().includes(query),
    );
  }, [rssEpisodeQuery, rssEpisodes]);
  const visibleRssEpisodes = useMemo(
    () => filteredRssEpisodes.slice(0, rssEpisodeLimit),
    [filteredRssEpisodes, rssEpisodeLimit],
  );

  const previewSource = useMemo(() => {
    if (activeTab === "file" && file) {
      return { kind: "file" as const, file };
    }
    if (activeTab === "link" && linkUrl.trim() && linkProvider) {
      return { kind: "link" as const, url: linkUrl.trim(), provider: linkProvider };
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
  }, [activeTab, file, linkUrl, linkProvider, selectedEpisodes]);

  // Reset detected duration whenever the source identity changes so a new file
  // / link URL / RSS episode triggers fresh detection.
  const sourceIdentity = useMemo(() => {
    if (!previewSource) return "";
    if (previewSource.kind === "file") {
      return `file:${previewSource.file.name}:${previewSource.file.size}:${previewSource.file.lastModified}`;
    }
    if (previewSource.kind === "link") return `link:${previewSource.url}`;
    return `rss:${selectedEpisodes[0]?.id ?? ""}`;
  }, [previewSource, selectedEpisodes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceIdentity is an explicit reset trigger for derived duration state.
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

  const acceptFile = useCallback((next: File) => {
    setFile(next);
    setActiveTab("file");
    setErrorMessage(null);
    setDurationSec(null);
    setStartSec(0);
    setEndSec(0);
  }, []);

  // Full-page drop target: dropping anywhere on /upload accepts the file
  // (and stops the browser from navigating away).
  useEffect(() => {
    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }
    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setPageDragActive(true);
    }
    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
    }
    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setPageDragActive(false);
    }
    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setPageDragActive(false);
      if (busy || uploadSourceLocked) return;
      const dropped = event.dataTransfer?.files?.[0];
      if (dropped) acceptFile(dropped);
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [busy, uploadSourceLocked, acceptFile]);

  const hasSource =
    (activeTab === "file" && file) ||
    (activeTab === "link" && linkUrl.trim().length > 0) ||
    (activeTab === "rss" && selectedEpisodes.length > 0);

  const sourceChosen =
    Boolean(resumeData) ||
    (activeTab === "file" && Boolean(file)) ||
    (activeTab === "link" && linkUrl.trim().length > 0) ||
    (activeTab === "rss" && rssCommitted);

  const submitDisabled = busy || !hasSource || !title.trim();

  // Smart paste detection — provider detection lives in @narriflow/validators (frozen contract).
  const trimmedPaste = pasteValue.trim();
  const pasteDetectedProvider = useMemo(
    () => detectLinkProvider(trimmedPaste),
    [trimmedPaste],
  );
  const detectedKind: "link" | "rss" | null =
    pasteOverride === "link"
      ? trimmedPaste
        ? "link"
        : null
      : pasteOverride === "rss"
        ? trimmedPaste
          ? "rss"
          : null
        : pasteDetectedProvider
          ? "link"
          : looksLikeUrl(trimmedPaste)
            ? "rss"
            : null;

  function commitPastedLink() {
    if (!detectedKind || busy) return;
    setErrorMessage(null);
    if (detectedKind === "link") {
      setActiveTab("link");
      setLinkUrl(trimmedPaste);
      setLinkProvider(pasteDetectedProvider ?? detectLinkProvider(trimmedPaste));
      return;
    }
    setActiveTab("rss");
    setRssUrl(trimmedPaste);
    setRssCommitted(true);
    void handleRssPreview(trimmedPaste);
  }

  function handleChangeSource() {
    if (busy || uploadSourceLocked) return;
    setFile(null);
    setLinkUrl("");
    setLinkProvider(null);
    setRssCommitted(false);
    setRssEpisodes([]);
    setSelectedEpisodeIds([]);
    setRssEpisodeQuery("");
    setRssEpisodeLimit(RSS_EPISODE_PAGE_SIZE);
    setRssNotice(null);
    setRssError(null);
    setErrorMessage(null);
    setActiveTab("file");
  }

  function getFormValues() {
    const hasKnownDuration = typeof durationSec === "number" && durationSec > 0;
    const nextStartSec = Math.max(0, Math.floor(startSec));
    const nextEndSec = hasKnownDuration
      ? Math.min(durationSec, Math.max(nextStartSec + 1, Math.floor(endSec)))
      : null;
    const hasCustomWindow =
      hasKnownDuration &&
      nextEndSec !== null &&
      (nextStartSec > 0 || nextEndSec < durationSec);

    return {
      languageCode,
      mode,
      clipLengthPreset: clipLength,
      autoHook,
      specificMoments,
      processingStartSec: hasCustomWindow ? nextStartSec : null,
      processingEndSec: hasCustomWindow ? nextEndSec : null,
      captionPreset,
      brandTemplateId,
      brandProfileId,
      clipCountTarget,
      platformTargets,
      autoRenderClips,
      toneConstraints,
    };
  }

  async function handleFileUploadAndGenerate() {
    if (!file || !title.trim()) {
      setErrorMessage("Add a title and choose a file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorMessage(
        "That file is over the 5 GB limit. Trim it, or import via a video link/RSS instead.",
      );
      return;
    }
    if (
      file.type &&
      !file.type.startsWith("video/") &&
      !file.type.startsWith("audio/")
    ) {
      setErrorMessage("Unsupported file type — upload a video or audio file.");
      return;
    }

    setErrorMessage(null);
    await uploadAdapter.start({
      file,
      title: title.trim(),
      brandTemplateId,
      brandProfileId,
      generationContext: buildUploadGenerationContext(getFormValues()),
    });
  }

  async function handleRssPreview(url: string = rssUrl) {
    if (!url.trim()) {
      setRssError("Paste an RSS feed URL first.");
      return;
    }
    setRssPreviewLoading(true);
    setRssNotice(null);
    setRssError(null);
    try {
      const response = await fetch("/api/ingest/rss/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssUrl: url.trim() }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        requestId?: string;
        details?: Record<string, unknown>;
        issues?: BrowserRequestFailure["issues"];
        retryAfterSeconds?: number;
        episodes?: RssEpisode[];
      };
      if (!response.ok || !payload.episodes) {
        const message = recoverRssRequest(
          payload,
          setRssError,
          "Could not load RSS episodes.",
        );
        toaster.error({ title: "RSS preview failed", description: message });
        return;
      }
      setRssEpisodes(payload.episodes);
      setSelectedEpisodeIds(payload.episodes.slice(0, 1).map((e) => e.id));
      setRssEpisodeQuery("");
      setRssEpisodeLimit(RSS_EPISODE_PAGE_SIZE);
      rssCommitTokenRef.current = null;
      setRssNotice(`Found ${payload.episodes.length} episodes.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not preview RSS feed.";
      setRssError(message);
      toaster.error({ title: "RSS preview failed", description: message });
    } finally {
      setRssPreviewLoading(false);
    }
  }

  async function handleRssImportAndGenerate() {
    if (!rssUrl.trim() || selectedEpisodes.length === 0) {
      setErrorMessage("Select at least one episode to import.");
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Importing episode and queueing generation…");

    try {
      const formData = buildUploadSettingsFormData(getFormValues());
      formData.set("rssUrl", rssUrl.trim());
      formData.set("titlePrefix", title.trim());
      formData.set("episodeIds", JSON.stringify(selectedEpisodeIds.slice(0, 1)));
      rssCommitTokenRef.current ??= crypto.randomUUID();
      formData.set("commitToken", rssCommitTokenRef.current);
      const result = await generateFromRssAction(formData);
      if (!result.ok) {
        const message = recoverRssRequest(
          result,
          setErrorMessage,
          "RSS import failed.",
        );
        toaster.error({ title: "RSS import failed", description: message });
        return;
      }
      if (result.projectId) {
        router.push(`/projects/${result.projectId}`);
        router.refresh();
      } else {
        router.push("/projects");
        router.refresh();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "RSS import failed.";
      setErrorMessage(message);
      toaster.error({ title: "RSS import failed", description: message });
    } finally {
      setSubmitting(false);
      setStatusMessage(null);
    }
  }

  function toggleEpisode(episodeId: string, checked: boolean) {
    setSelectedEpisodeIds((current) => {
      if (checked) return [episodeId]; // single-select for v1; clip generation per-episode
      return current.filter((id) => id !== episodeId);
    });
  }

  // Link path has its own Commit → Configure CTAs inside LinkImportFlow —
  // this shared submit zone now only serves the unchanged file/RSS flows.
  function handleSubmit() {
    if (activeTab === "file") return handleFileUploadAndGenerate();
    if (activeTab === "rss") return handleRssImportAndGenerate();
  }

  const submitLabel =
    mode === "caption_only"
      ? "Get captioned video in 1 click"
      : "Get clips in 1 click";

  const sourceKindLabel =
    activeTab === "file"
      ? "Local file"
      : activeTab === "link"
        ? linkProvider
          ? linkProviderLabel(linkProvider)
          : "Video link"
        : "RSS feed";

  return (
    <Box position="relative">
      {/* Full-page drop overlay — dropping anywhere on /upload works. */}
      {pageDragActive && (
        <Flex
          position="fixed"
          inset="0"
          zIndex="overlay"
          align="center"
          justify="center"
          bg="bg/85"
          backdropFilter="blur(2px)"
          pointerEvents="none"
        >
          <Flex
            direction="column"
            align="center"
            gap="3"
            px="12"
            py="10"
            borderWidth="1px"
            borderStyle="solid"
            borderColor="accent.solid"
            borderRadius="l3"
            bg="bg.panel"
            boxShadow="cardHover"
          >
            <Box color="accent.fg">
              <Upload size={24} strokeWidth={1.75} />
            </Box>
            <Text textStyle="title" fontSize="18px" color="fg">
              Drop to upload
            </Text>
            <Text textStyle="eyebrow" color="fg.subtle">
              Anywhere on this page
            </Text>
          </Flex>
        </Flex>
      )}

      {!sourceChosen ? (
        /* Source selection */
        <Stack gap="8" maxW="820px" mx="auto" bg="bg.dialog" borderWidth="1px" borderColor="border.subtle" borderRadius="l3" p={{base:"4",md:"6"}}>
          <Stack gap="1"><Text fontSize="xs" color="fg.subtle">New project</Text><Text as="h2" fontSize="md" fontWeight="500">Choose your source</Text></Stack>
          <SimpleGrid columns={3} gap={{base:"2",sm:"4"}} py={{base:"0",md:"3"}}>
          <Box
            position="relative"
            borderRadius="l2"
            outline={dropzoneDragOver ? "2px solid" : undefined}
            outlineColor="accent.solid"
            transition="border-color 120ms ease, background 120ms ease"
            css={{
              "&:has(input:focus-visible)": {
                outline: "2px solid var(--chakra-colors-accent-solid)",
                outlineOffset: "2px",
              },
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDropzoneDragOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropzoneDragOver(true);
            }}
            onDragLeave={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              setDropzoneDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDropzoneDragOver(false);
              if (busy) return;
              const dropped = event.dataTransfer?.files?.[0];
              if (dropped) acceptFile(dropped);
            }}
          >
            <Stack gap="3" pointerEvents="none">
              <Flex h={{ base: "86px", md: "128px" }} align="center" justify="center" bg="bg.panel" borderRadius="l2" color={dropzoneDragOver ? "accent.fg" : "fg.muted"}><Upload size={28} strokeWidth={1.5} /></Flex>
              <Text fontSize={{ base: "xs", md: "sm" }} fontWeight="500">Upload a file</Text>
              <Text fontSize="xs" color="fg.subtle" display={{ base: "none", sm: "block" }}>Choose a video or audio file from your device.</Text>
            </Stack>
            <input
              type="file"
              accept={FILE_ACCEPT}
              aria-label="Choose a video or audio file"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                if (next) acceptFile(next);
              }}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                opacity: 0,
                cursor: "pointer",
              }}
            />
          </Box>

          {[{title:"Paste a link", description:"YouTube, Vimeo, or another supported video URL.", value:"link" as const, icon:Link2}, {title:"Podcast feed", description:"Choose episodes from a public RSS feed.", value:"rss" as const, icon:AudioLines}].map(({title,description,value,icon:Icon}) => (
            <Box key={value} asChild cursor="pointer" alignSelf="start" minW="0">
              <button type="button" aria-pressed={pasteOverride === value} onClick={() => {setPasteOverride(value); document.getElementById("import-source-url")?.focus();}}>
                <Stack gap="3" textAlign="left">
                  <Flex h={{ base: "86px", md: "128px" }} align="center" justify="center" bg="bg.panel" borderWidth="1px" borderColor={pasteOverride === value ? "border.control" : "transparent"} borderRadius="l2" color="fg.muted" _hover={{ bg: "bg.muted", color: "fg" }}><Icon size={28} strokeWidth={1.5}/></Flex>
                  <Text fontSize={{ base: "xs", md: "sm" }} fontWeight="500">{title}</Text>
                  <Text display={{base:"none",sm:"block"}} fontSize="xs" color="fg.subtle">{description}</Text>
                </Stack>
              </button>
            </Box>
          ))}
          </SimpleGrid>
          {/* Smart paste — one field, auto-detects a provider link vs RSS */}
          <Stack gap="3">
            <Flex align="center" gap="4">
              <Text
                textStyle="eyebrow"
                fontWeight="500"
                color="fg.subtle"
              >
                Video link or RSS feed
              </Text>
            </Flex>
            {/* The paste field is the primary path — attached solid Continue
                is this view's one solid button. */}
            <Flex gap="2" bg="bg.panel" borderWidth="1px" borderColor="border" borderRadius="l2" p="2">
              <Input
                id="import-source-url"
                value={pasteValue}
                onChange={(event) => setPasteValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitPastedLink();
                  }
                }}
                placeholder="Paste a video link or RSS feed"
                type="url"
                aria-label="Video link or RSS URL"
                flex="1"
                variant="flushed"
                borderWidth="0"
                px="3"
              />
              <Button
                onClick={commitPastedLink}
                disabled={!detectedKind || busy}
                type="button"

              >
                Continue
              </Button>
            </Flex>
            <Flex justify="space-between" align="center" gap="3" wrap="wrap">
              <Flex align="center" gap="2">
                <Text fontSize="11px" color="fg.subtle">
                  Treat link as
                </Text>
                <SegmentedControl
                  size="sm"
                  items={[
                    { label: "Auto", value: "auto" },
                    { label: "Video link", value: "link" },
                    { label: "RSS feed", value: "rss" },
                  ]}
                  value={pasteOverride}
                  onValueChange={(next) =>
                    setPasteOverride(next as PasteOverride)
                  }
                />
              </Flex>
              <Box minH="4">
                {trimmedPaste && detectedKind === "link" && (
                  <Flex align="center" gap="1.5">
                    <Box w="6px" h="6px" borderRadius="1px" bg="accent.solid" />
                    <Text textStyle="eyebrow" color="fg.muted">
                      {pasteDetectedProvider
                        ? `Detected: ${linkProviderLabel(pasteDetectedProvider)}`
                        : "Video link detected"}
                    </Text>
                  </Flex>
                )}
                {trimmedPaste && detectedKind === "rss" && (
                  <Flex align="center" gap="1.5">
                    <Box w="6px" h="6px" borderRadius="1px" bg="accent.solid" />
                    <Text textStyle="eyebrow" color="fg.muted">
                      RSS feed detected
                    </Text>
                  </Flex>
                )}
                {trimmedPaste && !detectedKind && (
                  <Flex align="center" gap="1.5" color="danger.fg">
                    <AlertTriangle size={12} strokeWidth={2} />
                    <Text fontSize="11px" fontWeight="500">
                      Paste a full URL, like https://…
                    </Text>
                  </Flex>
                )}
              </Box>
            </Flex>
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              Supported: {LINK_PROVIDER_LABELS_JOINED} — or a podcast RSS feed
            </Text>
            {errorMessage && <ErrorNotice message={errorMessage} />}
          </Stack>

          <RecommendationCard />
        </Stack>
      ) : activeTab === "link" ? (
        /* Link path: its own Commit → Configure state machine — see
           link-import-flow.tsx. File/RSS keep the unchanged single-step
           grid below. */
        <LinkImportFlow
          linkUrl={resumeData?.sourceMediaUrl ?? linkUrl}
          linkProvider={
            (resumeData?.sourceProvider as LinkProviderId | null) ?? linkProvider ?? "youtube"
          }
          brandTemplates={brandTemplates}
          brandProfiles={brandProfiles}
          usageSummary={usageSummary}
          resumeData={resumeData}
          onChangeSource={handleChangeSource}
        />
      ) : (
        /* STEP 2 — preview + settings bands */
        <Grid
          templateColumns={{ base: "1fr", lg: "1.1fr 1fr" }}
          gap="8"
          animation="fade-up"
        >
          {/* LEFT — source */}
          <Box
            alignSelf="start"
            position={{ base: "static", lg: "sticky" }}
            top={{ lg: "6" }}
          >
            <Flex align="center" justify="space-between" mb="2">
              <Flex align="center" gap="1.5">
                <Text textStyle="eyebrow" color="fg.subtle">
                  Source · {sourceKindLabel}
                </Text>
              </Flex>
              <chakra.button
                type="button"
                onClick={handleChangeSource}
                disabled={busy || uploadSourceLocked}
                fontSize="12px"
                color="fg"
                textDecoration="underline"
                textUnderlineOffset="2px"
                cursor="pointer"
                transition="color 120ms ease"
                _hover={{ color: "fg.muted" }}
                _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
              >
                Change source
              </chakra.button>
            </Flex>
            <Stack layerStyle="band" gap="4">
              <VideoPreview
                source={previewSource}
                onDurationKnown={handleDurationKnown}
                durationSec={durationSec}
              />

              {activeTab === "rss" && (
                <Stack gap="2">
                  {rssPreviewLoading && (
                    <Flex align="center" gap="2">
                      <Spinner size="xs" />
                      <Text fontSize="12.5px" color="fg.muted">
                        Loading episodes…
                      </Text>
                    </Flex>
                  )}
                  {rssError && <ErrorNotice message={rssError} />}
                  {!rssPreviewLoading && rssNotice && (
                    <Text textStyle="data" fontSize="11px" color="fg.muted">
                      {rssNotice}
                    </Text>
                  )}
                  {rssEpisodes.length > 0 && (
                    <Stack gap="2.5">
                      <Input
                        aria-label="Search RSS episodes"
                        placeholder="Search episodes"
                        value={rssEpisodeQuery}
                        onChange={(event) => {
                          setRssEpisodeQuery(event.target.value);
                          setRssEpisodeLimit(RSS_EPISODE_PAGE_SIZE);
                        }}
                        size="sm"
                      />
                      <Flex align="center" justify="space-between" gap="2">
                        <Text textStyle="data" fontSize="10.5px" color="fg.subtle">
                          Showing {visibleRssEpisodes.length} of {filteredRssEpisodes.length}
                        </Text>
                        {rssEpisodeQuery && filteredRssEpisodes.length !== rssEpisodes.length && (
                          <chakra.button
                            type="button"
                            onClick={() => {
                              setRssEpisodeQuery("");
                              setRssEpisodeLimit(RSS_EPISODE_PAGE_SIZE);
                            }}
                            fontSize="11px"
                            color="fg.muted"
                            textDecoration="underline"
                            textUnderlineOffset="2px"
                          >
                            Clear search
                          </chakra.button>
                        )}
                      </Flex>
                      <RadioGroup
                        value={selectedEpisodeIds[0] ?? ""}
                        onValueChange={(next) => toggleEpisode(next, true)}
                      >
                        <Stack
                          gap="0"
                          maxH="60"
                          overflowY="auto"
                          borderTopWidth="1px"
                          borderTopColor="border"
                        >
                          {visibleRssEpisodes.map((episode) => (
                            <Box
                              key={episode.id}
                              py="2.5"
                              px="1"
                              borderBottomWidth="1px"
                              borderBottomColor="border.subtle"
                              transition="background 120ms ease"
                              _hover={{ bg: "bg.subtle" }}
                            >
                              <Radio value={episode.id} w="full">
                                <Box overflow="hidden" minW="0">
                                  <Text
                                    fontSize="13px"
                                    fontWeight="500"
                                    color="fg"
                                    truncate
                                  >
                                    {episode.title}
                                  </Text>
                                  <Text
                                    textStyle="data"
                                    fontSize="11px"
                                    color="fg.subtle"
                                    mt="0.5"
                                  >
                                    {episode.publishedAt
                                      ? formatDate(episode.publishedAt) ||
                                        episode.publishedAt
                                      : "Unknown publish date"}
                                  </Text>
                                </Box>
                              </Radio>
                            </Box>
                          ))}
                          {visibleRssEpisodes.length === 0 && (
                            <Text py="4" px="1" fontSize="12px" color="fg.muted">
                              No episodes match this search.
                            </Text>
                          )}
                        </Stack>
                      </RadioGroup>
                      {visibleRssEpisodes.length < filteredRssEpisodes.length && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setRssEpisodeLimit((current) =>
                              Math.min(
                                current + RSS_EPISODE_PAGE_SIZE,
                                filteredRssEpisodes.length,
                              ),
                            )
                          }
                        >
                          Show {Math.min(
                            RSS_EPISODE_PAGE_SIZE,
                            filteredRssEpisodes.length - visibleRssEpisodes.length,
                          )} more
                        </Button>
                      )}
                    </Stack>
                  )}
                </Stack>
              )}
            </Stack>
          </Box>

          {/* RIGHT — settings as rule-band sections */}
          <Stack gap="8">
            <fieldset
              disabled={uploadSourceLocked}
              aria-disabled={uploadSourceLocked || undefined}
              inert={uploadSourceLocked || undefined}
              style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
            >
              <Stack gap="8">
                <SettingsBand eyebrow="Project">
              <Input
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Episode 45 — Founder interview"
                value={title}
                aria-label="Project title"
              />
                </SettingsBand>

                <SettingsBand eyebrow="Mode">
                  <ModeTabs value={mode} onChange={setMode} />
                </SettingsBand>

                <SettingsBand eyebrow="Speech language">
                  <LanguageSelect
                    value={languageCode}
                    onChange={setLanguageCode}
                  />
                </SettingsBand>

                {/* ProcessingTimeline draws its own label under the section rule. */}
                <Box layerStyle="band">
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
                </Box>

                {/* BrandTemplatePicker draws its own label + Manage link. */}
                <Box layerStyle="band">
              <BrandTemplatePicker
                builtIns={brandTemplates.builtIns}
                mine={brandTemplates.mine}
                value={brandTemplateId}
                onChange={setBrandTemplateId}
                profiles={brandProfiles.items}
                profileValue={brandProfileId}
                onProfileChange={setBrandProfileId}
              />
                </Box>

                {mode === "clip" && (
                  <SettingsBand eyebrow="Clip settings">
                <ClipSettingsForm
                  clipLength={clipLength}
                  onClipLengthChange={setClipLength}
                  autoHook={autoHook}
                  onAutoHookChange={setAutoHook}
                  specificMoments={specificMoments}
                  onSpecificMomentsChange={setSpecificMoments}
                  platformTargets={platformTargets}
                  onPlatformTargetsChange={setPlatformTargets}
                  clipCountTarget={clipCountTarget}
                  onClipCountTargetChange={setClipCountTarget}
                  autoRenderClips={autoRenderClips}
                  onAutoRenderClipsChange={setAutoRenderClips}
                  toneConstraints={toneConstraints}
                  onToneConstraintsChange={setToneConstraints}
                />
                  </SettingsBand>
                )}

                {mode === "caption_only" && (
                  <Box layerStyle="band">
                <Stack gap="3">
                  <CaptionPresetSelect
                    value={captionPreset}
                    onChange={setCaptionPreset}
                  />
                  <Flex gap="2" align="flex-start">
                    <Box color="fg.subtle" mt="0.5" flexShrink={0}>
                      <Info size={13} strokeWidth={2} />
                    </Box>
                    <Text fontSize="12px" color="fg.muted" lineHeight="1.5">
                      We transcribe your full video, then render it at original
                      length with burned-in captions. No clipping.
                    </Text>
                  </Flex>
                </Stack>
                  </Box>
                )}
              </Stack>
            </fieldset>

            {/* Submit zone */}
            <Stack gap="3" pt="1">
              {activeTab === "file" && (
                <UploadSessionStatusPanel
                  snapshot={uploadSnapshot}
                  statusRef={uploadStatusRef}
                />
              )}
              {activeTab === "rss" && submitting && statusMessage && (
                <Flex align="center" gap="2">
                  <Spinner size="xs" />
                  <Text fontSize="12.5px" color="fg.muted">
                    {statusMessage}
                  </Text>
                </Flex>
              )}
              {errorMessage && <ErrorNotice message={errorMessage} />}
              <HStack gap="2">
                <Button
                  disabled={submitDisabled}
                  onClick={() => {
                    if (
                      activeTab === "file" &&
                      uploadSnapshot.canStartFresh
                    ) {
                      void uploadAdapter.startFresh();
                      return;
                    }
                    void handleSubmit();
                  }}
                  type="button"
                  size="md"
                  flex="1"
                >
                  {activeTab === "file"
                    ? uploadSnapshot.phase === "paused"
                      ? "Resume upload"
                      : uploadSnapshot.canStartFresh
                        ? "Start fresh upload"
                      : uploadSnapshot.phase === "failed"
                        ? "Try upload again"
                        : uploadSnapshot.phase === "verifying"
                          ? "Verifying…"
                          : uploadSnapshot.phase === "uploading"
                            ? "Uploading…"
                            : uploadSnapshot.phase === "preparing"
                              ? "Preparing…"
                              : submitLabel
                    : submitting
                      ? "Working…"
                      : submitLabel}
                </Button>
                {activeTab === "file" && (
                  <UploadSessionSecondaryActions
                    snapshot={uploadSnapshot}
                    onPause={() => void uploadAdapter.pause()}
                    onDiscard={() => void uploadAdapter.discard()}
                  />
                )}
              </HStack>
              <Text fontSize="11px" color="fg.subtle" textAlign="center">
                Using video you don&apos;t own may violate copyright laws.
              </Text>
            </Stack>
          </Stack>
        </Grid>
      )}
    </Box>
  );
}
