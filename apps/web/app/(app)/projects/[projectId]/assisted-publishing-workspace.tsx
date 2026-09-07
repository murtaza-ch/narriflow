"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Image as ImageIcon,
  Library,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { Input } from "@narriflow/ui/components/input";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Select } from "@narriflow/ui/components/select";
import { Slider } from "@narriflow/ui/components/slider";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Textarea } from "@narriflow/ui/components/textarea";
import {
  clipExportSnapshotSchema,
  SOCIAL_PROVIDER_CAPABILITIES,
  type ClipExportSnapshot,
  type ClipSnapshot,
  type SocialAccountSnapshot,
  type SocialPlatform,
  type SocialThumbnailSelection,
} from "@narriflow/validators";
import { formatDateInputInTimeZone, formatDuration } from "@/lib/format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";

type Notice = { tone: "success" | "danger" | "warning"; text: string };

type CopyDraft = {
  variantId: string;
  caption: string;
  hashtags: string;
  title: string;
  confirmed: boolean;
  edited: boolean;
};

type VisualAsset = {
  id: string;
  title: string;
  kind: "image" | "video";
  contentType: string;
  sizeBytes: number;
  fingerprint: string;
  provenance: "uploaded" | "generated" | "extracted_frame";
  accessUrl: string | null;
};

type ThumbnailTarget = { clipId: string; platform: SocialPlatform };

type BulkResult = {
  id: string;
  status: "completed" | "partial" | "failed" | "running";
  counts: { succeeded: number; ineligible: number; failed: number };
  items: Array<{
    id: string;
    clipId: string;
    platform: SocialPlatform;
    status: "pending" | "processing" | "succeeded" | "ineligible" | "failed";
    errorCode: string | null;
    retryable: boolean;
  }>;
};

const platformOrder = Object.keys(SOCIAL_PLATFORM_LABELS) as SocialPlatform[];

function key(clipId: string, platform: SocialPlatform) {
  return `${clipId}:${platform}`;
}

function hashtags(value: string) {
  return [...new Set(value.match(/#[^\s#]+/gu) ?? [])];
}

function composedLength(draft: CopyDraft) {
  const tags = hashtags(draft.hashtags).join(" ");
  return tags ? `${draft.caption.trim()}\n\n${tags}`.length : draft.caption.trim().length;
}

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  return fallback;
}

async function responseJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function exactPublicationExport(
  clip: ClipSnapshot,
  platforms: SocialPlatform[],
  exports: ClipExportSnapshot[],
) {
  for (const clipExport of exports) {
    if (
      clipExport.clipId !== clip.id ||
      clipExport.editorRevision !== clip.editorRevision ||
      clipExport.isOlderVersion
    ) continue;
    const variant = clipExport.variants.find((candidate) =>
      candidate.hasAsset && platforms.every((platform) =>
        SOCIAL_PROVIDER_CAPABILITIES[platform].aspectRatios.some(
          (ratio) => ratio === candidate.aspectRatio,
        ),
      ),
    );
    if (variant) return { clipExport, variant };
  }
  return null;
}

function thumbnailAssetIsCompatible(asset: VisualAsset, platform: SocialPlatform) {
  if (asset.kind !== "image") return false;
  if (!["image/jpeg", "image/png", "image/webp"].includes(asset.contentType)) return false;
  if (platform === "youtube_shorts") {
    return ["image/jpeg", "image/png"].includes(asset.contentType) && asset.sizeBytes <= 2_000_000;
  }
  return true;
}

function platformSettings(platform: SocialPlatform, settings: Record<SocialPlatform, Record<string, unknown>>) {
  return settings[platform] ?? {};
}

export function AssistedPublishingWorkspace({
  projectId,
  clips,
  accounts,
  workspaceTimezone,
  assistedCopyEnabled,
  customThumbnailsEnabled,
  campaignSchedulingEnabled,
  canUploadVisualAssets,
  facebookPublishingEnabled,
	canOverrideReview,
  onScheduled,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  accounts: SocialAccountSnapshot[];
  workspaceTimezone: string;
  assistedCopyEnabled: boolean;
  customThumbnailsEnabled: boolean;
  campaignSchedulingEnabled: boolean;
  canUploadVisualAssets: boolean;
  facebookPublishingEnabled: boolean;
	canOverrideReview: boolean;
  onScheduled(): void;
}) {
  const eligibleAccounts = useMemo(
    () => accounts.filter((account) =>
      account.status === "active" &&
      (account.platform !== "facebook_reels" || facebookPublishingEnabled),
    ),
    [accounts, facebookPublishingEnabled],
  );
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>(clips[0] ? [clips[0].id] : []);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(eligibleAccounts[0] ? [eligibleAccounts[0].id] : []);
  const [campaignNote, setCampaignNote] = useState("");
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [lockedPhrases, setLockedPhrases] = useState("");
  const [lockedHashtags, setLockedHashtags] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CopyDraft>>({});
  const [nativeSettings, setNativeSettings] = useState<Record<SocialPlatform, Record<string, unknown>>>(() => ({
    youtube_shorts: { youtubePrivacyStatus: "public" },
    instagram_reels: { shareToFeed: true },
    facebook_reels: {},
    tiktok: {
      tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      isAigc: false,
    },
    linkedin: { linkedinVisibility: "PUBLIC" },
    x: {},
  }));
  const [thumbnails, setThumbnails] = useState<Record<string, SocialThumbnailSelection>>({});
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [startDate, setStartDate] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("17:00");
  const [frequencyUnit, setFrequencyUnit] = useState<"hours" | "days">("hours");
  const [frequencyValue, setFrequencyValue] = useState("2");
  const [dstDisambiguation, setDstDisambiguation] = useState<"earlier" | "later" | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
	const bulkAttemptRef = useRef<{ signature: string; key: string } | null>(null);
	const [reviewOverrideReason, setReviewOverrideReason] = useState("");
  const [thumbnailTarget, setThumbnailTarget] = useState<ThumbnailTarget | null>(null);
  const [thumbnailTab, setThumbnailTab] = useState<"frames" | "library">("frames");
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [exports, setExports] = useState<ClipExportSnapshot[]>([]);
	const [exportsLoaded, setExportsLoaded] = useState(false);
  const [assetLoading, setAssetLoading] = useState(false);
  const [frameTimeMs, setFrameTimeMs] = useState(1_000);
  const [frameBusy, setFrameBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
		setStartDate(formatDateInputInTimeZone(new Date(), workspaceTimezone, 1));
	}, [workspaceTimezone]);

	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const response = await fetch(`/api/projects/${projectId}/exports/current`, { cache: "no-store" });
				const payload = await responseJson(response) as { exports?: unknown } | null;
				const parsed = clipExportSnapshotSchema.array().safeParse(payload?.exports);
				if (!active) return;
				if (!response.ok || !parsed.success) {
					throw new Error(errorMessage(payload, "Current exports could not be loaded."));
				}
				setExports(parsed.data);
			} catch (error) {
				if (active) setNotice({
					tone: "danger",
					text: error instanceof Error ? error.message : "Current exports could not be loaded.",
				});
			} finally {
				if (active) setExportsLoaded(true);
			}
		})();
		return () => { active = false; };
	}, [projectId]);

  const selectedClips = clips.filter((clip) => selectedClipIds.includes(clip.id));
  const selectedAccounts = eligibleAccounts.filter((account) => selectedAccountIds.includes(account.id));
  const selectedPlatforms = platformOrder.filter((platform) =>
    selectedAccounts.some((account) => account.platform === platform),
  );
  const requiredKeys = selectedClips.flatMap((clip) => selectedPlatforms.map((platform) => key(clip.id, platform)));
  const allConfirmed = requiredKeys.length > 0 && requiredKeys.every((draftKey) => drafts[draftKey]?.confirmed);
  const commonRatioMissing = selectedPlatforms.length > 0 &&
		selectedClips.some((clip) => !exactPublicationExport(clip, selectedPlatforms, exports));

  function toggleClip(clipId: string) {
    setSelectedClipIds((current) => current.includes(clipId)
      ? current.filter((id) => id !== clipId)
      : [...current, clipId]);
    setBulkResult(null);
  }

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) => current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId]);
    setBulkResult(null);
  }

  function addInstruction(value: string) {
    setRevisionInstruction((current) => current.includes(value)
      ? current
      : [current.trim(), value].filter(Boolean).join(" "));
  }

  async function generateCopy() {
    if (!campaignNote.trim() || selectedClips.length === 0 || selectedPlatforms.length === 0) {
      setNotice({ tone: "danger", text: "Choose clips and accounts, then add a short campaign direction." });
      return;
    }
    setGenerating(true);
    setNotice(null);
    setBulkResult(null);
    try {
      const next: Record<string, CopyDraft> = {};
		const skippedGuidance = new Set<string>();
      for (const clip of selectedClips) {
        const response = await fetch(`/api/projects/${projectId}/assisted-copy/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clipId: clip.id,
            idempotencyKey: crypto.randomUUID(),
            platforms: selectedPlatforms,
            campaignNote: campaignNote.trim(),
            revisionInstruction: revisionInstruction.trim() || undefined,
            lockedPhrases: lockedPhrases.split(",").map((value) => value.trim()).filter(Boolean),
            lockedHashtags: hashtags(lockedHashtags),
          }),
        });
				const payload = await responseJson(response) as {
					skippedGuidance?: string[];
					variants?: Array<{
          id: string;
          platform: SocialPlatform;
          caption: string;
          hashtags: string[];
          title: string | null;
          confirmed: boolean;
          edited: boolean;
					}>
				} | null;
        if (!response.ok || !payload?.variants) {
          throw new Error(errorMessage(payload, `Copy generation failed for clip ${clip.index + 1}.`));
        }
        for (const variant of payload.variants) {
          next[key(clip.id, variant.platform)] = {
            variantId: variant.id,
            caption: variant.caption,
            hashtags: variant.hashtags.join(" "),
            title: variant.title ?? "",
            confirmed: variant.confirmed,
            edited: variant.edited,
          };
        }
				for (const guidance of payload.skippedGuidance ?? []) skippedGuidance.add(guidance);
      }
      setDrafts((current) => ({ ...current, ...next }));
			setNotice(skippedGuidance.size > 0
				? {
					tone: "warning",
					text: `Generated ${Object.keys(next).length} drafts without unavailable ${[...skippedGuidance].join(", ").replaceAll("_", " ")} guidance. Review them carefully.`,
				}
				: { tone: "success", text: `Generated ${Object.keys(next).length} platform drafts. Review and confirm each one.` });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "Social copy could not be generated." });
    } finally {
      setGenerating(false);
    }
  }

  function updateDraft(draftKey: string, patch: Partial<CopyDraft>) {
    setDrafts((current) => {
      const existing = current[draftKey];
      if (!existing) return current;
      return { ...current, [draftKey]: { ...existing, ...patch, confirmed: false } };
    });
    setBulkResult(null);
  }

  async function confirmDraft(clipId: string, platform: SocialPlatform) {
    const draftKey = key(clipId, platform);
    const draft = drafts[draftKey];
    if (!draft) return;
    if (composedLength(draft) > SOCIAL_PROVIDER_CAPABILITIES[platform].textLimit) {
      setNotice({ tone: "danger", text: `${SOCIAL_PLATFORM_LABELS[platform]} copy exceeds its character limit.` });
      return;
    }
    setConfirming(draftKey);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/assisted-copy/variants/${draft.variantId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caption: draft.caption.trim(),
            hashtags: hashtags(draft.hashtags),
            title: draft.title.trim() || null,
          }),
        },
      );
      const payload = await responseJson(response) as Partial<CopyDraft> | null;
      if (!response.ok) throw new Error(errorMessage(payload, "This draft could not be confirmed."));
      setDrafts((current) => ({
        ...current,
        [draftKey]: {
          ...draft,
          caption: typeof payload?.caption === "string" ? payload.caption : draft.caption,
          hashtags: Array.isArray(payload?.hashtags) ? payload.hashtags.join(" ") : draft.hashtags,
          title: typeof payload?.title === "string" ? payload.title : draft.title,
          confirmed: true,
          edited: payload?.edited === true,
        },
      }));
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "This draft could not be confirmed." });
    } finally {
      setConfirming(null);
    }
  }

  async function loadThumbnailSources() {
    setAssetLoading(true);
    try {
      const [assetResponse, exportResponse] = await Promise.all([
        fetch("/api/visual-assets", { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/exports/current`, { cache: "no-store" }),
      ]);
      const [assetPayload, exportPayload] = await Promise.all([
        responseJson(assetResponse),
        responseJson(exportResponse),
      ]) as [{ assets?: VisualAsset[] } | null, { exports?: unknown } | null];
      if (!assetResponse.ok || !assetPayload?.assets) {
        throw new Error(errorMessage(assetPayload, "Thumbnail library could not be loaded."));
      }
      const parsedExports = clipExportSnapshotSchema.array().safeParse(exportPayload?.exports);
      if (!exportResponse.ok || !parsedExports.success) {
        throw new Error(errorMessage(exportPayload, "Current exports could not be loaded."));
      }
      setAssets(assetPayload.assets.filter((asset) => asset.kind === "image"));
      setExports(parsedExports.data);
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "Thumbnail sources could not be loaded." });
    } finally {
      setAssetLoading(false);
    }
  }

  function openThumbnail(clipId: string, platform: SocialPlatform) {
    setThumbnailTarget({ clipId, platform });
    setThumbnailTab("frames");
    setFrameTimeMs(1_000);
    void loadThumbnailSources();
  }

  function chooseAsset(asset: VisualAsset) {
    if (!thumbnailTarget || asset.provenance === "extracted_frame") return;
    setThumbnails((current) => ({
      ...current,
      [key(thumbnailTarget.clipId, thumbnailTarget.platform)]: {
        assetId: asset.id,
        fingerprint: asset.fingerprint,
        source: asset.provenance,
        sourceTimeMs: null,
      },
    }));
    setThumbnailTarget(null);
  }

  async function prepareFrame(exportVariantId: string) {
    if (!thumbnailTarget) return;
    setFrameBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/thumbnail-frames`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clipId: thumbnailTarget.clipId,
          exportVariantId,
          sourceTimeMs: frameTimeMs,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      let operation = await responseJson(response) as {
        id?: string;
        status?: string;
        errorCode?: string | null;
        asset?: { id: string; fingerprint: string } | null;
      } | null;
      if (!response.ok || !operation?.id) {
        throw new Error(errorMessage(operation, "The selected frame could not be prepared."));
      }
			if (operation.status === "failed") {
				const retried = await fetch(
					`/api/projects/${projectId}/thumbnail-frames/${operation.id}/retry`,
					{ method: "POST" },
				);
				operation = await responseJson(retried) as typeof operation;
				if (!retried.ok || !operation?.id) {
					throw new Error(errorMessage(operation, "The selected frame could not be retried."));
				}
			}
      for (let attempt = 0; attempt < 40 && operation.status !== "completed"; attempt += 1) {
        if (operation.status === "failed") {
          throw new Error(operation.errorCode ?? "Frame extraction failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const poll = await fetch(`/api/projects/${projectId}/thumbnail-frames/${operation.id}`, { cache: "no-store" });
        operation = await responseJson(poll) as typeof operation;
        if (!poll.ok) throw new Error(errorMessage(operation, "Frame preparation status was unavailable."));
      }
      if (operation?.status !== "completed" || !operation.asset) {
        throw new Error("Frame preparation is taking longer than expected. It will remain queued safely.");
      }
      setThumbnails((current) => ({
        ...current,
        [key(thumbnailTarget.clipId, thumbnailTarget.platform)]: {
          assetId: operation!.asset!.id,
          fingerprint: operation!.asset!.fingerprint,
          source: "extracted_frame",
          sourceTimeMs: frameTimeMs,
        },
      }));
      setThumbnailTarget(null);
      setNotice({ tone: "success", text: `Prepared the frame at ${(frameTimeMs / 1_000).toFixed(1)}s.` });
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "The selected frame could not be prepared." });
    } finally {
      setFrameBusy(false);
    }
  }

  async function uploadAsset(file: File | null) {
    if (!file || !canUploadVisualAssets || !thumbnailTarget) return;
    const uploadIsCompatible = thumbnailAssetIsCompatible({
      id: "upload",
      title: file.name,
      kind: "image",
      contentType: file.type,
      sizeBytes: file.size,
      fingerprint: "",
      provenance: "uploaded",
      accessUrl: null,
    }, thumbnailTarget.platform);
    if (!uploadIsCompatible) {
      setNotice({
        tone: "danger",
        text: thumbnailTarget.platform === "youtube_shorts"
          ? "YouTube thumbnails must be JPEG or PNG files no larger than 2 MB."
          : "Use a JPEG, PNG, or WebP image.",
      });
      return;
    }
    setUploadBusy(true);
    setNotice(null);
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const fingerprint = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      const presign = await fetch("/api/visual-assets/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
      });
      const prepared = await responseJson(presign) as { key?: string; uploadUrl?: string } | null;
      if (!presign.ok || !prepared?.key || !prepared.uploadUrl) {
        throw new Error(errorMessage(prepared, "The image upload could not start."));
      }
      const uploaded = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploaded.ok) throw new Error("The image could not be uploaded to storage.");
      const finalized = await fetch("/api/visual-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: prepared.key,
          contentType: file.type,
          sizeBytes: file.size,
          fingerprint,
          title: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Thumbnail",
          provenance: "uploaded",
        }),
      });
      const asset = await responseJson(finalized) as VisualAsset | null;
      if (!finalized.ok || !asset?.id) throw new Error(errorMessage(asset, "The uploaded image could not be verified."));
      setAssets((current) => [asset, ...current.filter((candidate) => candidate.id !== asset.id)]);
      chooseAsset(asset);
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "The image could not be uploaded." });
    } finally {
      setUploadBusy(false);
    }
  }

  function bulkPayload(idempotencyKey: string) {
    return {
      idempotencyKey,
      accounts: selectedAccounts.map((account) => ({ accountId: account.id, platform: account.platform })),
      clips: selectedClips.map((clip) => {
				const selected = exactPublicationExport(clip, selectedPlatforms, exports)!;
				const { variant } = selected;
        return {
          clipId: clip.id,
          expectedEditorRevision: clip.editorRevision,
				exportId: selected.clipExport.id,
				exportVariantId: variant.id,
				aspectRatio: variant.aspectRatio,
				resolution: variant.resolution,
          copyByPlatform: Object.fromEntries(selectedPlatforms.map((platform) => {
            const draft = drafts[key(clip.id, platform)]!;
            return [platform, {
              variantId: draft.variantId,
              caption: draft.caption.trim(),
              hashtags: hashtags(draft.hashtags),
              title: draft.title.trim() || null,
              providerSettings: platformSettings(platform, nativeSettings),
            }];
          })),
          thumbnailByPlatform: Object.fromEntries(selectedPlatforms.map((platform) => [
            platform,
            thumbnails[key(clip.id, platform)] ?? null,
          ])),
        };
      }),
      startDate,
      timeZone: workspaceTimezone,
      postingWindow: { start: windowStart, end: windowEnd },
      frequency: { unit: frequencyUnit, value: Number(frequencyValue) },
      dstDisambiguation,
		reviewOverrideReason: reviewOverrideReason.trim() || null,
    };
  }

  async function scheduleCampaign(retry = false) {
		if (!allConfirmed || commonRatioMissing || !exportsLoaded || !startDate || scheduling) return;
		const signature = JSON.stringify(bulkPayload("00000000-0000-4000-8000-000000000000"));
		const requestKey = !retry && bulkAttemptRef.current?.signature === signature
			? bulkAttemptRef.current.key
			: crypto.randomUUID();
		bulkAttemptRef.current = { signature, key: requestKey };
    setScheduling(true);
    setNotice(null);
		let receivedResponse = false;
    try {
      const response = await fetch(`/api/projects/${projectId}/campaign-operations/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bulkPayload(requestKey)),
      });
			receivedResponse = true;
      const payload = await responseJson(response) as BulkResult | null;
      if (!response.ok || !payload?.counts) {
        if (payload && typeof payload === "object" && "error" in payload && payload.error === "schedule_local_time_ambiguous") {
          setNotice({ tone: "warning", text: errorMessage(payload, "That local time occurs twice. Choose the first or second occurrence below.") });
          return;
        }
        throw new Error(errorMessage(payload, "The campaign schedule could not be created."));
      }
      setBulkResult(payload);
			bulkAttemptRef.current = null;
      setNotice({
        tone: payload.status === "completed" ? "success" : "warning",
        text: payload.status === "completed"
          ? `Scheduled ${payload.counts.succeeded} post${payload.counts.succeeded === 1 ? "" : "s"}.`
          : `Scheduled ${payload.counts.succeeded}; ${payload.counts.ineligible + payload.counts.failed} need attention.`,
      });
      onScheduled();
    } catch (error) {
			if (receivedResponse) bulkAttemptRef.current = null;
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "The campaign schedule could not be created." });
    } finally {
      setScheduling(false);
    }
  }

  const targetCapability = thumbnailTarget ? SOCIAL_PROVIDER_CAPABILITIES[thumbnailTarget.platform] : null;
	const targetClip = thumbnailTarget ? clips.find((clip) => clip.id === thumbnailTarget.clipId) : null;
	const targetExport = targetClip && thumbnailTarget
		? exactPublicationExport(targetClip, [thumbnailTarget.platform], exports)?.clipExport ?? null
		: null;
  const targetFrameVariant = targetExport?.variants.find((variant) =>
    variant.hasAsset && targetCapability?.aspectRatios.some((ratio) => ratio === variant.aspectRatio),
  ) ?? null;
	const frameMax = Math.max(0, Math.round((targetFrameVariant?.durationSec ?? 0) * 1_000) - 1);
  const libraryAssets = assets.filter((asset) =>
    thumbnailTarget &&
    asset.provenance !== "extracted_frame" &&
    targetCapability?.thumbnailSources.some((source) => source === asset.provenance) &&
    thumbnailAssetIsCompatible(asset, thumbnailTarget.platform),
  );

  return (
    <Stack gap="5">
      <Box>
        <Flex px={{ base: "4", md: "5" }} py="4" align={{ base: "start", md: "center" }} justify="space-between" gap="4" direction={{ base: "column", md: "row" }}>
          <Box>
            <Text textStyle="eyebrow" color="accent.fg">Publishing workspace</Text>
            <Text mt="1" fontFamily="display" fontSize={{ base: "xl", md: "2xl" }} fontWeight="500" letterSpacing="-0.025em">
              Schedule a campaign
            </Text>
            <Text mt="1" fontSize="sm" color="fg.muted" maxW="680px">
              Choose clips and accounts, review your captions, and set a publishing schedule.
            </Text>
          </Box>
          <Flex align="center" gap="2" color="fg.subtle">
            <LockKeyhole size={14} />
            <Text textStyle="eyebrow">Editor confirmed</Text>
          </Flex>
        </Flex>
      </Box>

      <Grid templateColumns={{ base: "1fr", xl: "280px minmax(0, 1fr) 300px" }} gap="0" borderWidth="1px" borderRadius="l3" overflow="hidden" bg="bg.panel" borderColor="border.subtle">
        <Box borderEndWidth={{ xl: "1px" }} borderBottomWidth={{ base: "1px", xl: "0" }} borderColor="border.subtle">
          <Flex px="4" py="3" align="center" justify="space-between" borderBottomWidth="1px" borderColor="border.subtle">
            <Text textStyle="eyebrow" color="fg.subtle">Clips</Text>
            <Button size="sm" variant="ghost" onClick={() => setSelectedClipIds(selectedClipIds.length === clips.length ? [] : clips.map((clip) => clip.id))}>
              {selectedClipIds.length === clips.length ? "Clear" : "Select all"}
            </Button>
          </Flex>
          <Stack gap="0" maxH={{ xl: "720px" }} overflowY="auto">
            {clips.map((clip) => {
              const selected = selectedClipIds.includes(clip.id);
              return (
                <Flex key={clip.id} position="relative" px="4" py="3" gap="3" align="start" bg={selected ? "bg.muted" : "transparent"} borderBottomWidth="1px" borderColor="border.subtle" transition="background 120ms ease" _hover={{ bg: selected ? "bg.muted" : "bg.subtle" }}>
                  {selected ? <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg="accent.solid" /> : null}
                  <Checkbox checked={selected} onCheckedChange={() => toggleClip(clip.id)} aria-label={`Select clip ${clip.index + 1}`} />
                  <Box minW="0" flex="1" onClick={() => toggleClip(clip.id)} cursor="pointer">
                    <Flex align="center" justify="space-between" gap="2">
                      <Text fontSize="13px" fontWeight="600" truncate>{clip.title || `Clip ${clip.index + 1}`}</Text>
                      <Text textStyle="data" fontSize="11px" color={clip.viralityScore >= 75 ? "success.fg" : "fg.muted"}>{clip.viralityScore}</Text>
                    </Flex>
                    <Text mt="0.5" fontSize="11px" color="fg.subtle" lineClamp="2">{clip.hookText}</Text>
                    <Text mt="1" textStyle="data" fontSize="10px" color="fg.subtle">{formatDuration(clip.durationSec)}</Text>
                  </Box>
                </Flex>
              );
            })}
          </Stack>
        </Box>

        <Stack gap="0" minW="0">
          <Box p={{ base: "4", md: "5" }} borderBottomWidth="1px" borderColor="border.subtle">
            <Flex align="center" justify="space-between" gap="3" mb="3">
              <Box>
                <Text textStyle="eyebrow" color="fg.subtle">AI direction</Text>
                <Text fontSize="xs" color="fg.muted">One brief, adapted to every selected platform.</Text>
              </Box>
              {!assistedCopyEnabled ? <Text fontSize="11px" color="warning.fg">Creator plan required</Text> : null}
            </Flex>
            <Textarea value={campaignNote} onChange={(event) => setCampaignNote(event.target.value.slice(0, 2_000))} minH="88px" resize="vertical" borderColor="border.control" placeholder="What should this campaign communicate? Add the offer, audience, and non-negotiable facts." />
            <Flex mt="2" gap="2" wrap="wrap">
              {["Use our Tone & Voice.", "Add relevant hashtags.", "Include a clear CTA."].map((action) => (
                <Button key={action} size="sm" variant="outline" onClick={() => addInstruction(action)}>{action.replace(/\.$/, "")}</Button>
              ))}
            </Flex>
            {revisionInstruction ? (
              <Input mt="2" size="sm" value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value.slice(0, 1_000))} aria-label="Regeneration instruction" />
            ) : null}
            <Grid mt="3" templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="2">
              <Input size="sm" value={lockedPhrases} onChange={(event) => setLockedPhrases(event.target.value)} placeholder="Keep exact phrases, comma separated" aria-label="Locked phrases" />
              <Input size="sm" value={lockedHashtags} onChange={(event) => setLockedHashtags(event.target.value)} placeholder="#KeepThis #AndThis" aria-label="Locked hashtags" />
            </Grid>
            <Flex mt="3" justify="flex-end">
              <Button size="sm" variant="outline" disabled={!assistedCopyEnabled || generating || !campaignNote.trim() || selectedClips.length === 0 || selectedPlatforms.length === 0} onClick={() => void generateCopy()}>
                {generating ? <Spinner size="xs" /> : <WandSparkles size={14} />}
                {generating ? "Generating…" : Object.keys(drafts).length > 0 ? "Regenerate all" : "Generate descriptions"}
              </Button>
            </Flex>
          </Box>

          <Box p={{ base: "4", md: "5" }}>
            <Text textStyle="eyebrow" color="fg.subtle">Destination copy</Text>
            {requiredKeys.length === 0 ? (
              <Flex py="12" direction="column" align="center" textAlign="center" color="fg.muted">
                <Sparkles size={22} />
                <Text mt="2" fontSize="sm" fontWeight="600" color="fg">Select clips and accounts</Text>
                <Text mt="1" fontSize="xs">Your per-platform drafts will appear here.</Text>
              </Flex>
            ) : (
              <Stack mt="3" gap="3">
                {selectedClips.flatMap((clip) => selectedPlatforms.map((platform) => {
                  const draftKey = key(clip.id, platform);
                  const draft = drafts[draftKey];
                  const capability = SOCIAL_PROVIDER_CAPABILITIES[platform];
                  const thumbnail = thumbnails[draftKey];
                  return (
                    <Box key={draftKey} layerStyle="well" borderStartWidth="3px" borderStartColor={draft?.confirmed ? "success.solid" : draft ? "accent.solid" : "border.emphasized"}>
                      <Flex px="4" py="3" align="center" justify="space-between" gap="3" borderBottomWidth="1px" borderColor="border.subtle">
                        <Box minW="0">
                          <Text fontSize="13px" fontWeight="650" truncate>{SOCIAL_PLATFORM_LABELS[platform]} · {clip.title || `Clip ${clip.index + 1}`}</Text>
                          <Text textStyle="eyebrow" color={draft?.confirmed ? "success.fg" : "fg.subtle"}>{draft?.confirmed ? "Confirmed" : draft ? "Review required" : "Not generated"}</Text>
                        </Box>
                        {capability.thumbnailSources.length > 0 ? (
                          <Button size="sm" variant="ghost" disabled={!customThumbnailsEnabled} onClick={() => openThumbnail(clip.id, platform)}>
                            <ImageIcon size={13} /> {thumbnail ? "Change cover" : "Add cover"}
                          </Button>
                        ) : (
                          <Text fontSize="11px" color="fg.subtle">Provider chooses cover</Text>
                        )}
                      </Flex>
                      {draft ? (
                        <Stack p="4" gap="3">
                          {capability.titleField ? (
                            <Box>
                              <Text textStyle="eyebrow" color="fg.subtle" mb="1">Title</Text>
                              <Input size="sm" value={draft.title} maxLength={100} onChange={(event) => updateDraft(draftKey, { title: event.target.value })} />
                            </Box>
                          ) : null}
                          <Box>
                            <Flex justify="space-between" gap="2" mb="1">
                              <Text textStyle="eyebrow" color="fg.subtle">Description</Text>
                              <Text textStyle="data" fontSize="10px" color={composedLength(draft) > capability.textLimit ? "danger.fg" : "fg.subtle"}>{composedLength(draft)} / {capability.textLimit}</Text>
                            </Flex>
                            <Textarea value={draft.caption} onChange={(event) => updateDraft(draftKey, { caption: event.target.value })} minH="92px" resize="vertical" borderColor="border.control" />
                          </Box>
                          <Input size="sm" value={draft.hashtags} onChange={(event) => updateDraft(draftKey, { hashtags: event.target.value })} placeholder="#topic #campaign" aria-label={`${SOCIAL_PLATFORM_LABELS[platform]} hashtags`} />
                          {platform === "youtube_shorts" ? (
                            <Select size="sm" label="Visibility" items={[{ value: "public", label: "Public" }, { value: "unlisted", label: "Unlisted" }, { value: "private", label: "Private" }]} value={String(platformSettings(platform, nativeSettings).youtubePrivacyStatus ?? "public")} onValueChange={(value) => setNativeSettings((current) => ({ ...current, [platform]: { ...current[platform], youtubePrivacyStatus: value } }))} />
                          ) : null}
                          {platform === "instagram_reels" ? (
                            <Checkbox checked={platformSettings(platform, nativeSettings).shareToFeed !== false} onCheckedChange={(checked) => setNativeSettings((current) => ({ ...current, [platform]: { ...current[platform], shareToFeed: checked } }))}>Also share to feed</Checkbox>
                          ) : null}
                          {platform === "tiktok" ? (
                            <Stack gap="2">
                              <Select size="sm" label="Visibility" items={[{ value: "PUBLIC_TO_EVERYONE", label: "Everyone" }, { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" }, { value: "SELF_ONLY", label: "Only me" }]} value={String(platformSettings(platform, nativeSettings).tiktokPrivacyLevel ?? "PUBLIC_TO_EVERYONE")} onValueChange={(value) => setNativeSettings((current) => ({ ...current, [platform]: { ...current[platform], tiktokPrivacyLevel: value } }))} />
                              <Checkbox checked={platformSettings(platform, nativeSettings).isAigc === true} onCheckedChange={(checked) => setNativeSettings((current) => ({ ...current, [platform]: { ...current[platform], isAigc: checked } }))}>Label AI-generated content</Checkbox>
                            </Stack>
                          ) : null}
                          {platform === "linkedin" ? (
                            <Select size="sm" label="Audience" items={[{ value: "PUBLIC", label: "Anyone" }, { value: "CONNECTIONS", label: "Connections" }]} value={String(platformSettings(platform, nativeSettings).linkedinVisibility ?? "PUBLIC")} onValueChange={(value) => setNativeSettings((current) => ({ ...current, [platform]: { ...current[platform], linkedinVisibility: value } }))} />
                          ) : null}
                          {thumbnail ? (
                            <Flex align="center" gap="2" color="fg.muted"><Check size={12} /><Text fontSize="11px">{thumbnail.source === "extracted_frame" ? `Frame at ${((thumbnail.sourceTimeMs ?? 0) / 1_000).toFixed(1)}s` : thumbnail.source === "generated" ? "Generated image selected" : "Uploaded image selected"}</Text></Flex>
                          ) : null}
                          <Flex justify="flex-end">
                            <Button size="sm" variant={draft.confirmed ? "ghost" : "outline"} disabled={confirming !== null || composedLength(draft) > capability.textLimit} onClick={() => void confirmDraft(clip.id, platform)}>
                              {confirming === draftKey ? <Spinner size="xs" /> : draft.confirmed ? <CheckCircle2 size={13} /> : <Check size={13} />}
                              {draft.confirmed ? "Confirmed" : "Confirm exact copy"}
                            </Button>
                          </Flex>
                        </Stack>
                      ) : (
                        <Text p="4" fontSize="xs" color="fg.muted">Generate descriptions to create this draft.</Text>
                      )}
                    </Box>
                  );
                }))}
              </Stack>
            )}
          </Box>
        </Stack>

        <Box borderStartWidth={{ xl: "1px" }} borderTopWidth={{ base: "1px", xl: "0" }} borderColor="border.subtle" p="4">
          <Text textStyle="eyebrow" color="fg.subtle">Destinations</Text>
          <Stack mt="3" gap="2">
            {eligibleAccounts.map((account) => {
              const checked = selectedAccountIds.includes(account.id);
              return (
                <Flex key={account.id} p="3" gap="2.5" align="center" borderWidth="1px" borderColor={checked ? "accent.solid" : "border.subtle"} bg={checked ? "accent.subtle" : "transparent"}>
                  <Checkbox checked={checked} onCheckedChange={() => toggleAccount(account.id)} aria-label={`Select ${account.displayName}`} />
                  <Box minW="0">
                    <Text fontSize="12px" fontWeight="650" truncate>{account.displayName}</Text>
                    <Text fontSize="10px" color="fg.subtle" truncate>{SOCIAL_PLATFORM_LABELS[account.platform]}{account.handle ? ` · ${account.handle}` : ""}</Text>
                  </Box>
                </Flex>
              );
            })}
            {eligibleAccounts.length === 0 ? (
              <Link href="/settings/social-accounts"><Text fontSize="xs" color="accent.fg" textDecoration="underline">Connect a social account</Text></Link>
            ) : null}
          </Stack>

          <Box mt="6" pt="4" borderTopWidth="1px" borderColor="border.subtle">
            <Text textStyle="eyebrow" color="fg.subtle">Schedule window</Text>
            <Text mt="1" fontSize="11px" color="fg.muted">{workspaceTimezone}</Text>
            <Stack mt="3" gap="3">
              <Box><Text textStyle="eyebrow" color="fg.subtle" mb="1">Start date</Text><Input type="date" size="sm" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Box>
              <Grid templateColumns="1fr 1fr" gap="2">
                <Box><Text textStyle="eyebrow" color="fg.subtle" mb="1">From</Text><Input type="time" size="sm" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} /></Box>
                <Box><Text textStyle="eyebrow" color="fg.subtle" mb="1">Until</Text><Input type="time" size="sm" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></Box>
              </Grid>
              <Grid templateColumns="1fr 1fr" gap="2">
                <Select size="sm" label="Cadence" items={[{ value: "hours", label: "Hours" }, { value: "days", label: "Days" }]} value={frequencyUnit} onValueChange={(value) => setFrequencyUnit(value as "hours" | "days")} />
                <Box><Text textStyle="eyebrow" color="fg.subtle" mb="1">Every</Text><Input type="number" min="1" max="30" size="sm" value={frequencyValue} onChange={(event) => setFrequencyValue(event.target.value)} /></Box>
              </Grid>
              <Select size="sm" label="Repeated DST hour" items={[{ value: "", label: "Ask if it occurs" }, { value: "earlier", label: "First occurrence" }, { value: "later", label: "Second occurrence" }]} value={dstDisambiguation ?? ""} onValueChange={(value) => setDstDisambiguation(value === "earlier" || value === "later" ? value : null)} />
				{canOverrideReview ? (
					<Box>
						<Text textStyle="eyebrow" color="fg.subtle" mb="1">Approval override</Text>
						<Textarea
							size="sm"
							rows={2}
							maxLength={500}
							placeholder="Optional reason when approved exports are unavailable"
							value={reviewOverrideReason}
							onChange={(event) => setReviewOverrideReason(event.target.value)}
						/>
					</Box>
				) : null}
            </Stack>
          </Box>

          <Box mt="6" pt="4" borderTopWidth="1px" borderColor="border.subtle">
            <Flex justify="space-between" gap="2"><Text fontSize="12px" color="fg.muted">Selected clips</Text><Text textStyle="data" fontSize="12px">{selectedClips.length}</Text></Flex>
            <Flex mt="1" justify="space-between" gap="2"><Text fontSize="12px" color="fg.muted">Destinations</Text><Text textStyle="data" fontSize="12px">{selectedAccounts.length}</Text></Flex>
            <Flex mt="1" justify="space-between" gap="2"><Text fontSize="12px" color="fg.muted">Posts</Text><Text textStyle="data" fontSize="12px">{selectedClips.length * selectedAccounts.length}</Text></Flex>
            {commonRatioMissing ? <Text mt="2" fontSize="11px" color="danger.fg">A selected clip has no ready aspect ratio shared by every destination.</Text> : null}
            {!allConfirmed && requiredKeys.length > 0 ? <Text mt="2" fontSize="11px" color="warning.fg">Confirm every platform draft before scheduling.</Text> : null}
			<Button mt="4" w="full" size="sm" disabled={!campaignSchedulingEnabled || !allConfirmed || commonRatioMissing || !exportsLoaded || !startDate || scheduling} onClick={() => void scheduleCampaign(false)}>
              {scheduling ? <Spinner size="xs" /> : <CalendarClock size={14} />}
              {scheduling
                ? "Scheduling…"
                : `Schedule ${selectedClips.length * selectedAccounts.length} ${selectedClips.length * selectedAccounts.length === 1 ? "post" : "posts"}`}
            </Button>
            {!campaignSchedulingEnabled ? <Text mt="2" fontSize="11px" color="warning.fg">Bulk scheduling requires Pro or Business.</Text> : null}
          </Box>
        </Box>
      </Grid>

      {notice ? (
        <Flex role="status" aria-live="polite" align="center" gap="2" color={notice.tone === "success" ? "success.fg" : notice.tone === "warning" ? "warning.fg" : "danger.fg"}>
          {notice.tone === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <Text fontSize="xs">{notice.text}</Text>
        </Flex>
      ) : null}

      {bulkResult ? (
        <Box layerStyle="well" borderStartWidth="3px" borderStartColor={bulkResult.status === "completed" ? "success.solid" : "warning.solid"}>
          <Flex p="4" align="center" justify="space-between" gap="3" wrap="wrap">
            <Box>
              <Text textStyle="eyebrow" color={bulkResult.status === "completed" ? "success.fg" : "warning.fg"}>{bulkResult.status === "completed" ? "Campaign scheduled" : "Partial outcome"}</Text>
              <Text mt="1" fontSize="xs" color="fg.muted">{bulkResult.counts.succeeded} scheduled · {bulkResult.counts.ineligible} ineligible · {bulkResult.counts.failed} retryable</Text>
            </Box>
            {bulkResult.counts.failed > 0 ? <Button size="sm" variant="outline" disabled={scheduling} onClick={() => void scheduleCampaign(true)}><RefreshCw size={13} /> Retry safely</Button> : null}
          </Flex>
          {bulkResult.items.some((item) => item.status !== "succeeded") ? (
            <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
              {bulkResult.items.filter((item) => item.status !== "succeeded").map((item) => (
                <Flex key={item.id} px="4" py="2" align="center" justify="space-between" gap="3" borderBottomWidth="1px" borderColor="border.subtle">
                  <Text fontSize="11px">{SOCIAL_PLATFORM_LABELS[item.platform]} · {clips.find((clip) => clip.id === item.clipId)?.title ?? "Clip"}</Text>
                  <Text textStyle="data" fontSize="10px" color="danger.fg">{item.errorCode ?? item.status}</Text>
                </Flex>
              ))}
            </Stack>
          ) : null}
        </Box>
      ) : null}

      <Dialog.Root open={thumbnailTarget !== null} onOpenChange={(details) => { if (!frameBusy && !uploadBusy && !details.open) setThumbnailTarget(null); }} placement="center" scrollBehavior="inside">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="760px">
              <Dialog.Header px="5" pt="5" pb="3" flexDirection="column" alignItems="stretch" gap="1">
                <Text textStyle="eyebrow" color="fg.subtle">Thumbnail</Text>
                <Dialog.Title fontFamily="display" fontSize="18px">Choose the exact cover</Dialog.Title>
                <Text fontSize="xs" color="fg.muted">Only controls supported by {thumbnailTarget ? SOCIAL_PLATFORM_LABELS[thumbnailTarget.platform] : "this platform"} are shown.</Text>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild><CloseButton size="sm" position="absolute" top="3" insetInlineEnd="3" /></Dialog.CloseTrigger>
              <Dialog.Body px="5" py="2">
                <Flex borderBottomWidth="1px" borderColor="border.subtle" gap="1">
                  {targetCapability?.thumbnailSources.some((source) => source === "extracted_frame") ? <Button size="sm" variant="ghost" borderBottomWidth="2px" borderRadius="0" borderColor={thumbnailTab === "frames" ? "accent.solid" : "transparent"} onClick={() => setThumbnailTab("frames")}><ImageIcon size={13} /> Choose a frame</Button> : null}
                  {targetCapability?.thumbnailSources.some((source) => source === "uploaded" || source === "generated") ? <Button size="sm" variant="ghost" borderBottomWidth="2px" borderRadius="0" borderColor={thumbnailTab === "library" ? "accent.solid" : "transparent"} onClick={() => setThumbnailTab("library")}><Library size={13} /> Library</Button> : null}
                </Flex>
                {assetLoading ? <Flex minH="300px" align="center" justify="center"><Spinner /></Flex> : thumbnailTab === "frames" ? (
                  targetFrameVariant?.previewUrl ? (
                    <Stack py="5" gap="4">
                      <MediaWell ratio={9 / 16} maxH="380px" mx="auto"><video ref={videoRef} src={targetFrameVariant.previewUrl} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "contain" }} /></MediaWell>
                      <Slider min={0} max={frameMax} step={100} value={Math.min(frameTimeMs, frameMax)} onValueChange={(value) => { const next = Number(value); setFrameTimeMs(next); if (videoRef.current) videoRef.current.currentTime = next / 1_000; }} label="Frame position" />
                      <Flex justify="space-between" align="center"><Text textStyle="data" fontSize="12px">{(frameTimeMs / 1_000).toFixed(1)}s</Text><Button size="sm" disabled={frameBusy} onClick={() => void prepareFrame(targetFrameVariant.id)}>{frameBusy ? <Spinner size="xs" /> : <Check size={14} />} Use this frame</Button></Flex>
                    </Stack>
                  ) : (
                    <Flex py="12" direction="column" align="center" textAlign="center"><ImageIcon size={22} /><Text mt="2" fontSize="sm" fontWeight="600">No current export</Text><Text mt="1" fontSize="xs" color="fg.muted">Export this clip at a supported ratio before choosing a frame.</Text></Flex>
                  )
                ) : (
                  <Stack py="5" gap="4">
                    <Flex gap="2" wrap="wrap">
                      {canUploadVisualAssets ? <Button size="sm" variant="outline" asChild><label><Upload size={13} />{uploadBusy ? "Uploading…" : "Upload image"}<input type="file" accept={thumbnailTarget?.platform === "youtube_shorts" ? "image/jpeg,image/png" : "image/jpeg,image/png,image/webp"} hidden disabled={uploadBusy} onChange={(event) => void uploadAsset(event.target.files?.[0] ?? null)} /></label></Button> : null}
                      {thumbnailTarget ? <Button size="sm" variant="outline" asChild><Link href={`/projects/${projectId}/clips/${thumbnailTarget.clipId}/studio`}><Sparkles size={13} /> Generate in Studio <ChevronRight size={12} /></Link></Button> : null}
                      <Button size="sm" variant="ghost" onClick={() => void loadThumbnailSources()}><RefreshCw size={13} /> Refresh</Button>
                    </Flex>
                    {libraryAssets.length > 0 ? (
                      <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)" }} gap="3">
                        {libraryAssets.map((asset) => (
                          <Box as="button" key={asset.id} textAlign="start" borderWidth="1px" borderColor="border.subtle" onClick={() => chooseAsset(asset)} _hover={{ borderColor: "accent.solid" }}>
                            <Box aspectRatio="16 / 9" bg="bg.muted" overflow="hidden">{asset.accessUrl ? <img src={asset.accessUrl} alt={asset.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</Box>
                            <Box p="2"><Text fontSize="11px" fontWeight="600" truncate>{asset.title}</Text><Text textStyle="eyebrow" color="fg.subtle">{asset.provenance}</Text></Box>
                          </Box>
                        ))}
                      </Grid>
                    ) : (
                      <Flex py="10" direction="column" align="center" textAlign="center"><Library size={22} /><Text mt="2" fontSize="sm" fontWeight="600">No compatible images yet</Text><Text mt="1" fontSize="xs" color="fg.muted">Upload one here or generate a thumbnail in Studio.</Text></Flex>
                    )}
                  </Stack>
                )}
              </Dialog.Body>
              <Dialog.Footer px="5" py="4"><Button variant="ghost" size="sm" disabled={frameBusy || uploadBusy} onClick={() => setThumbnailTarget(null)}>Cancel</Button></Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Stack>
  );
}
