"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  chakra,
  Flex,
  Portal,
  Popover,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  AlertTriangle,
  Clock,
  Link2,
  ArrowRight,
  ChevronDown,
  Palette,
  Sparkles,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  creditsForSourceSeconds,
  resolvePricingTier,
  type BrandTemplateSummary,
  type GenerationMode,
  type LinkProviderId,
  type RecipeSnapshot,
} from "@narriflow/validators";
import { formatDuration, formatTimecode } from "@/lib/format";
import {
  extractYoutubeId,
  youtubeFrameUrls,
  youtubeThumbnailUrl,
} from "../../projects/_lib/youtube";
import { ProcessingTimeline } from "../../_shared/processing-timeline";
import { BrandTemplatePicker } from "./brand-template-picker";
import { LanguageSelect } from "./language-select";
import { RecipePicker } from "./recipe-picker";
import type { RecipeFormSettings } from "../_lib/recipe-settings";
import { Switch } from "@narriflow/ui/components/switch";
import { VideoPreview } from "./video-preview";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UpgradePrompt } from "../../_components/upgrade";
import { UploadRefusalUpgrade } from "./upload-session-status";
import {
  fetchYoutubeMetadataAction,
  commitDriveImportAction,
  commitLinkImportAction,
} from "../actions";
import type { DrivePick } from "../_lib/google-drive-picker";
import {
  creditsUpgradePrompt,
  isAuthenticatedActionFailure,
  upgradePromptFromFailure,
  uploadLengthUpgradePrompt,
} from "@/lib/authenticated-request-browser";

/** Credits renew at midnight UTC, so the date is read in UTC. */
const RENEWAL_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Failure notice: Labeled danger panel with an icon. */
function ErrorNotice({ message }: { message: string }) {
  return (
    <Flex
      role="alert"
      align="center"
      gap="2.5"
      px="3"
      py="2.5"
      bg="danger.subtle"
      borderRadius="l2"
      position="relative"
      overflow="hidden"
    >
      <Box color="danger.fg" flexShrink={0}>
        <AlertTriangle size={14} strokeWidth={2} />
      </Box>
      <Text fontSize="13px" fontWeight="500" color="danger.fg">
        {message}
      </Text>
    </Flex>
  );
}

interface UsageSummary {
  tier: string;
  usedCredits: number;
  reservedCredits: number;
  remainingCredits: number;
  limitCredits: number;
  maxUploadSeconds: number;
  /** When this month's credits renew. */
  renewsAt: Date | string;
}

export interface CommitStepResult {
  projectId: string;
  title: string;
  languageCode: string;
  mode: GenerationMode;
  processingStartSec: number | null;
  processingEndSec: number | null;
}

interface CommitStepProps {
  linkUrl: string;
  linkProvider: LinkProviderId;
  /** Saved Recipes this form can be filled from. */
  recipes: RecipeSnapshot[];
  /** The Recipe's clip settings, which the Configure step starts from. */
  onRecipeApplied: (clip: RecipeFormSettings["clip"]) => void;
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
  usageSummary: UsageSummary;
  /** A Google Drive Picker file; imported through its token instead of `linkUrl`. */
  driveFile: DrivePick | null;
  commitToken: string;
  onCommitted: (result: CommitStepResult) => void;
}

/** A picked Drive file's name, without its extension, as the project title. */
function driveTitle(driveFile: DrivePick | null) {
  return driveFile?.name.replace(/\.[^/.]+$/, "").trim() ?? "";
}

export function CommitStep({
  linkUrl,
  linkProvider,
  recipes,
  onRecipeApplied,
  brandTemplates,
  brandProfiles,
  usageSummary,
  driveFile,
  commitToken,
  onCommitted,
}: CommitStepProps) {
  const [title, setTitle] = useState(() => driveTitle(driveFile));
  const titleTouchedRef = useRef(false);

  // A different picked file replaces a title the person hasn't edited.
  useEffect(() => {
    if (driveFile && !titleTouchedRef.current) setTitle(driveTitle(driveFile));
  }, [driveFile]);
  const [languageCode, setLanguageCode] = useState("auto");
  const [mode, setMode] = useState<GenerationMode>("clip");
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

  /** A Recipe only fills the form in; the form's own values are what is submitted. */
  function applyRecipe(settings: RecipeFormSettings) {
    setLanguageCode(settings.languageCode);
    setMode(settings.clip.mode);
    // A profile that is no longer there leaves the current choice alone.
    const profile = brandProfiles.items.find((candidate) => candidate.id === settings.brandProfileId);
    if (settings.brandProfileId === null || profile) {
      setBrandProfileId(settings.brandProfileId);
      setBrandTemplateId(profile?.defaultTemplateId ?? null);
    }
    onRecipeApplied(settings.clip);
  }

  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when the server refused this source for credits or length and a plan would admit it.
  const [refusalUpgrade, setRefusalUpgrade] = useState<UpgradePrompt | null>(null);

  const youtubeId =
    linkProvider === "youtube" ? extractYoutubeId(linkUrl) : null;

  // YouTube oEmbed prefill — server-side fetch, ~3s timeout, silent fallback.
  useEffect(() => {
    if (linkProvider !== "youtube") return;
    let cancelled = false;
    fetchYoutubeMetadataAction(linkUrl)
      .then((result) => {
        if (
          cancelled ||
          titleTouchedRef.current ||
          isAuthenticatedActionFailure(result) ||
          !result.title
        )
          return;
        setTitle(result.title);
      })
      .catch(() => {
        // Silent fallback — title stays editable and empty.
      });
    return () => {
      cancelled = true;
    };
  }, [linkUrl, linkProvider]);

  function handleDurationKnown(seconds: number) {
    setDurationSec((prev) => {
      if (prev === seconds) return prev;
      setStartSec(0);
      setEndSec(seconds);
      return seconds;
    });
  }

  const hasKnownDuration = typeof durationSec === "number" && durationSec > 0;
  const hasCustomWindow =
    hasKnownDuration && (startSec > 0 || endSec < (durationSec as number));

  // The whole source is charged, whatever window is selected.
  const estimatedCredits = hasKnownDuration
    ? creditsForSourceSeconds(durationSec)
    : null;
  const creditsLeft = usageSummary.remainingCredits;
  // An explicit locale so the server render and the browser agree.
  const credits = (value: number) => value.toLocaleString("en-US");
  // What "Brand preferences" holds right now, so it reads without opening.
  const brandSummary =
    [
      brandProfiles.items.find((profile) => profile.id === brandProfileId)?.name,
      [...brandTemplates.mine, ...brandTemplates.builtIns].find((template) => template.id === brandTemplateId)?.name,
    ]
      .filter(Boolean)
      .join(" · ") || "System default";

  const overUploadCap =
    hasKnownDuration && (durationSec as number) > usageSummary.maxUploadSeconds;
  // Guidance only; Processing Usage decides at admission and settlement.
  const wouldExceedMonthly =
    hasKnownDuration && estimatedCredits !== null && estimatedCredits > creditsLeft;
  // The plan that would admit this video; null when none does (explanation only).
  const tier = resolvePricingTier(usageSummary.tier);
  const planLimitUpgrade = overUploadCap
    ? // A plan that admits the length must also have room for its credits.
      uploadLengthUpgradePrompt(tier, durationSec as number, {
        spentCredits: usageSummary.usedCredits + usageSummary.reservedCredits,
        requestedCredits: estimatedCredits as number,
      })
    : wouldExceedMonthly
      ? creditsUpgradePrompt(
          tier,
          usageSummary.usedCredits + usageSummary.reservedCredits,
          estimatedCredits as number,
        )
      : null;
  const planLimitMessage = overUploadCap
    ? // The per-upload cap is enforced against the full source duration
      // (sourceDurationSeconds), not the trimmed processing window — trimming
      // here cannot bring this under the cap, so the copy must not suggest it.
      `This video is about ${Math.round((durationSec as number) / 60)} min, over the ${Math.round(
        usageSummary.maxUploadSeconds / 60,
      )}-min per-upload limit on your plan.${planLimitUpgrade ? "" : " Choose a shorter video."}`
    : wouldExceedMonthly
      ? `This video needs ${estimatedCredits} credits, but your workspace has ${creditsLeft} of ${usageSummary.limitCredits} left this month.${
          // No plan holds more: the next step is the renewal date.
          planLimitUpgrade ? "" : ` Credits renew ${RENEWAL_DATE.format(new Date(usageSummary.renewsAt))}.`
        }`
      : null;

  async function handleCommit() {
    setSubmitting(true);
    setErrorMessage(null);
    setRefusalUpgrade(null);
    const processingStartSec = hasCustomWindow ? Math.floor(startSec) : null;
    const processingEndSec = hasCustomWindow ? Math.floor(endSec) : null;
    const settings = {
      title: title.trim() || null,
      brandTemplateId,
      brandProfileId,
      commitToken,
      languageCode: languageCode === "auto" ? null : languageCode,
      mode,
      processingStartSec,
      processingEndSec,
    };
    const result = driveFile
      ? await commitDriveImportAction({
          ...settings,
          fileId: driveFile.fileId,
          accessToken: driveFile.accessToken,
        })
      : await commitLinkImportAction({ ...settings, url: linkUrl });
    if (!result.ok) {
      setErrorMessage(result.message);
      // The link, Drive pick, and settings stay as they are; the owner can open the plan dialog.
      setRefusalUpgrade(
        upgradePromptFromFailure({
          error: result.code,
          message: result.message,
          details: "details" in result ? result.details : undefined,
        }),
      );
      setSubmitting(false);
      return;
    }
    onCommitted({
      projectId: result.projectId,
      title: result.title,
      languageCode,
      mode,
      processingStartSec,
      processingEndSec,
    });
  }

  return (
    <Stack gap="5" maxW="480px" mx="auto" animation="fade-up">
      <Stack
        gap="5"
        bg="bg.panel"
        borderRadius="l3"
        borderWidth="1px"
        borderColor="border.card"
        p={{ base: "4", md: "6" }}
      >
        {/* Hidden YouTube IFrame duration probe — existing probe from
          video-preview.tsx, mounted off-screen so it never affects layout;
          the visible metadata row below draws its own thumbnail/title. */}
        {youtubeId && (
          <Box
            position="absolute"
            w="1px"
            h="1px"
            overflow="hidden"
            opacity="0"
            pointerEvents="none"
            aria-hidden
          >
            <VideoPreview
              source={{ kind: "link", url: linkUrl, provider: "youtube" }}
              onDurationKnown={handleDurationKnown}
              durationSec={durationSec}
            />
          </Box>
        )}

        {/* Metadata row */}
        <Box>
          <Flex gap="4" align="center">
            <MediaWell
              ratio={16 / 9}
              w={{ base: "96px", sm: "136px" }}
              flexShrink={0}
              timecode={hasKnownDuration ? formatDuration(durationSec as number) : undefined}
            >
              {youtubeId ? (
                <img
                  src={youtubeThumbnailUrl(youtubeId, "hq")}
                  alt=""
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <Flex
                  align="center"
                  justify="center"
                  position="absolute"
                  inset="0"
                  color="studio.fgMuted"
                >
                  <Link2 size={20} strokeWidth={1.75} />
                </Flex>
              )}
            </MediaWell>
            <Stack flex="1" minW="0" gap="1.5" align="flex-start">
              {/* Reads as the title; editable in place. */}
              <Input
                value={title}
                onChange={(event) => {
                  titleTouchedRef.current = true;
                  setTitle(event.target.value);
                }}
                placeholder="Give your project a name"
                aria-label="Project title"
                size="sm"
                w="full"
                px="2"
                ms="-2"
                fontSize="15px"
                fontWeight="500"
                bg="transparent"
                _hover={{ bg: "bg.soft" }}
                _focus={{ bg: "bg.soft" }}
              />
              {youtubeId ? (
                <Popover.Root positioning={{ placement: "bottom-start" }}>
                  <Popover.Trigger asChild>
                    <chakra.button
                      type="button"
                      display="inline-flex"
                      alignItems="center"
                      gap="1.5"
                      flexShrink={0}
                      px="2.5"
                      py="1.5"
                      borderRadius="l1"
                      bg="bg.soft"
                      cursor="pointer"
                      transition="background 120ms ease"
                      _hover={{ bg: "bg.softHover" }}
                    >
                      <Clock size={12} strokeWidth={1.75} />
                      <Text fontSize="12px" color="fg">
                        {!hasKnownDuration
                          ? "Detecting length…"
                          : hasCustomWindow
                            ? "Part of the video"
                            : "Whole video"}
                      </Text>
                      {hasKnownDuration ? (
                        <Text textStyle="data" fontSize="12px" color="fg.muted">
                          {hasCustomWindow
                            ? `${formatTimecode(startSec)}–${formatTimecode(endSec)}`
                            : formatTimecode(durationSec as number)}
                        </Text>
                      ) : null}
                      <ChevronDown size={12} />
                    </chakra.button>
                  </Popover.Trigger>
                  <Portal>
                    <Popover.Positioner>
                      <Popover.Content w="min(400px, calc(100vw - 24px))" p="4">
                        <ProcessingTimeline
                          frames={youtubeFrameUrls(youtubeId)}
                          durationSec={durationSec}
                          startSec={startSec}
                          endSec={endSec}
                          disabled={!hasKnownDuration}
                          hasSource={true}
                          onChange={(s, e) => {
                            setStartSec(s);
                            setEndSec(e);
                          }}
                        />
                      </Popover.Content>
                    </Popover.Positioner>
                  </Portal>
                </Popover.Root>
              ) : (
                <Text fontSize="12px" color="fg.muted" lineHeight="1.5">
                  Length is detected during import.
                </Text>
              )}
            </Stack>
          </Flex>
        </Box>

        <Stack gap="3">
          <RecipePicker recipes={recipes} onApply={applyRecipe} />
          <LanguageSelect value={languageCode} onChange={setLanguageCode} />
          <Switch
            checked={mode === "clip"}
            onCheckedChange={(checked) => setMode(checked ? "clip" : "caption_only")}
            inputProps={{ "aria-label": "Get AI clips" }}
            display="flex"
            flexDirection="row-reverse"
            justifyContent="space-between"
            w="full"
            minH="52px"
            px="3"
            py="2"
            borderRadius="l2"
            bg="bg.soft"
          >
            <Flex align="center" gap="2.5">
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
              <Stack gap="0">
                <Text as="span" fontSize="14px">Get AI clips</Text>
                <Text as="span" fontSize="12px" color="fg.muted">
                  {mode === "clip" ? "Find the best moments as short clips" : "Caption the whole video, no clips"}
                </Text>
              </Stack>
            </Flex>
          </Switch>
        </Stack>

        <chakra.details css={{ "&[open] .brand-chevron": { transform: "rotate(180deg)" } }}>
          <chakra.summary
            display="flex"
            alignItems="center"
            gap="2.5"
            minH="44px"
            px="3"
            borderRadius="l2"
            bg="bg.soft"
            cursor="pointer"
            fontSize="14px"
            listStyleType="none"
            transition="background 120ms ease"
            _hover={{ bg: "bg.softHover" }}
            css={{ "&::-webkit-details-marker": { display: "none" } }}
          >
            <Palette size={16} strokeWidth={1.75} aria-hidden="true" />
            Brand
            <Text as="span" ms="auto" fontSize="13px" color="fg.muted" truncate>
              {brandSummary}
            </Text>
            <Box as="span" className="brand-chevron" color="fg.muted" transition="transform 150ms ease" flexShrink={0}>
              <ChevronDown size={15} />
            </Box>
          </chakra.summary>
          <Box pt="4">
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
        </chakra.details>

        <Stack gap="2.5">
          {planLimitMessage && (
            <PlanLimitNotice message={planLimitMessage} upgrade={planLimitUpgrade} />
          )}
          {errorMessage && <ErrorNotice message={errorMessage} />}
          {errorMessage && refusalUpgrade && <UploadRefusalUpgrade prompt={refusalUpgrade} />}
          <Button
            onClick={handleCommit}
            disabled={submitting || overUploadCap || wouldExceedMonthly}
            type="button"
            size="md"
            h="46px"
          >
            {submitting ? (
              <>
                <Spinner size="xs" borderTopColor="brand.contrast" />
                <Text ms="1.5">Working…</Text>
              </>
            ) : (
              <>
                Import & continue <ArrowRight size={16} />
              </>
            )}
          </Button>
          <Text
            fontSize="12px"
            color="fg.subtle"
            textAlign="center"
            fontVariantNumeric="tabular-nums"
          >
            {hasKnownDuration
              ? `Uses ${credits(estimatedCredits ?? 0)} ${estimatedCredits === 1 ? "credit" : "credits"} · ${credits(creditsLeft)} of ${credits(usageSummary.limitCredits)} left`
              : `Credits confirmed after import · ${credits(creditsLeft)} of ${credits(usageSummary.limitCredits)} left`}
          </Text>
        </Stack>
      </Stack>
    </Stack>
  );
}
