"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { ShieldCheck } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  censorWordsToScan,
  detectAutoCensorSuggestions,
  isCensorSegmentStale,
  lowestTierWithFeature,
  PLAN_CATALOG,
  type AutoCensorSuggestion,
  type WorkspaceCensorWords,
} from "@narriflow/validators";
import { CensorWordListDialog } from "@/app/(app)/_components/censor-word-list-dialog";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";
import { AutoCensorReviewDrawer } from "../auto-censor-review-drawer";
import {
  AUTO_CENSOR_DEFAULT_EFFECTS,
  AUTO_CENSOR_SOUNDS,
  AUTO_CENSOR_TEXT_STYLES,
  autoCensorEffectsValid,
  autoCensorResultCountBucket,
  buildCensorSegments,
  censorChanges,
  describeCensorEffects,
  hasCensorChanges,
  groupAppliedCensorSegments,
  type AutoCensorEffects,
  type AutoCensorSound,
  type AutoCensorTextStyle,
} from "../auto-censor-review-model";
import { PANEL_PX, PanelButton, PanelEmpty, PanelSegmented, SectionLabel, chipProps, softButtonProps } from "./panel-ui";

const PADDING_SEC = 0.06;

/**
 * Auto-censor: pick how a censored word looks and sounds, then censor every
 * match in one click. "Review matches" is the per-word view; "Edit word list"
 * opens the Workspace, Project and Brand words the scan uses.
 */
export function CensorPanel() {
  const {
    editorDocument,
    editorRevision,
    utterances,
    clipWindow,
    autoCensorPolicy,
    setCensorSegments,
    censorWords,
    setCensorWords,
    updateProjectCensorTerms,
    replaceWorkspaceCensorWords,
    resetWorkspaceCensorWords,
    recordAutoCensorEvent,
    upgradePrompts,
  } = useStudio(
    "editorDocument", "editorRevision", "utterances", "clipWindow", "autoCensorPolicy",
    "setCensorSegments", "censorWords", "setCensorWords", "updateProjectCensorTerms", "replaceWorkspaceCensorWords", "resetWorkspaceCensorWords",
    "recordAutoCensorEvent", "upgradePrompts",
  );
  const { openUpgrade } = useUpgrade();
  const applyLock = autoCensorPolicy.canApply ? null : upgradePrompts.censoring;
  const [effects, setEffects] = useState<AutoCensorEffects>(AUTO_CENSOR_DEFAULT_EFFECTS);
  // Held by the Studio, so saved edits survive switching to another tool.
  const workspaceList: WorkspaceCensorWords = censorWords.workspace;
  const projectTerms = censorWords.project;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);
  const existing = editorDocument.censorSegments;

  // Until the list is edited, the scan uses the English defaults plus this clip's language.
  const workspaceWords = useMemo(
    () => censorWordsToScan(workspaceList, autoCensorPolicy.locale),
    [autoCensorPolicy.locale, workspaceList],
  );

  // The scan reads the corrected transcript and edits nothing; only Apply does.
  const suggestions = useMemo(
    () => detectAutoCensorSuggestions({
      documentRevision: editorRevision,
      locale: autoCensorPolicy.locale,
      clipWindow,
      deletedRanges: editorDocument.deletedRanges,
      transcript: utterances,
      workspaceTerms: workspaceWords,
      brandTerms: autoCensorPolicy.brandTerms,
      projectTerms,
      paddingSec: PADDING_SEC,
    }),
    [autoCensorPolicy.brandTerms, autoCensorPolicy.locale, clipWindow, editorDocument.deletedRanges, editorRevision, projectTerms, utterances, workspaceWords],
  );

  const recordEventBestEffort = (input: Parameters<typeof recordAutoCensorEvent>[0]) => {
    void recordAutoCensorEvent(input).catch(() => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "auto_censor_analytics_failed",
        eventType: input.type,
      }));
    });
  };

  // One analytics pair per opening of the panel, not per rescan.
  const reportedScan = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening the panel is the scan gesture; later rescans follow word-list edits.
  useEffect(() => {
    if (reportedScan.current) return;
    reportedScan.current = true;
    recordEventBestEffort({ type: "auto_censor_scan_started" });
    recordEventBestEffort({
      type: "auto_censor_scan_completed",
      resultCountBucket: autoCensorResultCountBucket(suggestions.length),
    });
  }, []);

  const pending = suggestions.filter(
    (suggestion) => hasCensorChanges(censorChanges(suggestion, existing, effects)),
  );
  const untimed = suggestions.filter((suggestion) => suggestion.timingLimitation !== null);
  const censoredGroups = groupAppliedCensorSegments(existing);
  const censoredCount = censoredGroups.length;
  // Enabled stale segments block export, so they stay visible even with no matches left.
  const staleCount = censoredGroups.filter((group) => existing.some((segment) =>
    group.segmentIds.includes(segment.id) && segment.enabled && isCensorSegmentStale(segment, utterances))).length;
  const effectsReady = autoCensorEffectsValid(effects);

  const apply = (matches: readonly AutoCensorSuggestion[]) => {
    try {
      const result = buildCensorSegments({
        suggestions: matches,
        existing,
        canApply: autoCensorPolicy.canApply,
        effects,
        paddingSec: PADDING_SEC,
        createId: () => crypto.randomUUID(),
      });
      if (result.words === 0) {
        toaster.create({
          type: "info",
          title: result.overLimit > 0 ? "No room for more censor edits" : "Nothing new to censor",
          description: result.overLimit > 0
            ? "A clip holds up to 256 censor edits. Remove some, then apply again."
            : "These words already look and sound like this.",
        });
        return;
      }
      if (!setCensorSegments(result.segments)) throw new Error("auto_censor_document_rejected");
      const staleCount = existing.filter((segment) => isCensorSegmentStale(segment, utterances)).length;
      recordEventBestEffort({
        type: "auto_censor_applied",
        selectedCount: Math.min(256, result.words),
        captionMaskCount: result.applied.filter((segment) => segment.treatment === "caption_mask").length,
        muteCount: result.applied.filter((segment) => segment.treatment === "mute").length,
        beepCount: result.applied.filter((segment) => segment.treatment === "beep").length,
        staleCount,
      });
      toaster.create({
        type: "success",
        title: `Censored ${result.words} ${result.words === 1 ? "word" : "words"}: ${describeCensorEffects(effects)}`,
        description: result.overLimit > 0
          ? `${result.overLimit} more didn't fit under the 256-edit limit. Undo restores the clip in one step.`
          : "Undo restores the clip in one step.",
      });
      setReviewOpen(false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "auto_censor_apply_failed";
      console.warn(JSON.stringify({ level: "warn", message: "auto_censor_apply_failed", code }));
      const entitlementRequired = code === "plan_feature_required";
      toaster.create({
        type: "error",
        title: entitlementRequired ? "Upgrade to apply Auto-censor" : "Auto-censor was not applied",
        description: entitlementRequired
          ? `Scanning is included. Applying edits is available on ${PLAN_CATALOG[lowestTierWithFeature("editor.censoring") ?? "creator"].name} and above.`
          : process.env.NODE_ENV === "development"
            ? code
            : "Your clip is unchanged. Try again.",
      });
    }
  };

  const applyAll = () => {
    if (pending.length === 0 || !effectsReady) return;
    if (applyLock?.tier) openUpgrade(applyLock);
    else apply(pending);
  };

  return (
    <Stack px={PANEL_PX} pb="6" gap="6">
      <Stack gap="0">
        <SectionLabel>Text style</SectionLabel>
        <Flex gap="2" flexWrap="wrap" role="group" aria-label="Text style">
          {AUTO_CENSOR_TEXT_STYLES.map((option) => (
            <Box
              key={option.value}
              as="button"
              aria-pressed={effects.textStyle === option.value}
              cursor="pointer"
              {...chipProps(effects.textStyle === option.value)}
              onClick={() => setEffects((current) => ({ ...current, textStyle: option.value as AutoCensorTextStyle }))}
            >
              {option.label}
            </Box>
          ))}
        </Flex>
      </Stack>

      <Stack gap="0">
        <SectionLabel>Sound effect</SectionLabel>
        <PanelSegmented
          ariaLabel="Sound effect"
          value={effects.sound}
          onChange={(sound: AutoCensorSound) => setEffects((current) => ({ ...current, sound }))}
          items={AUTO_CENSOR_SOUNDS}
        />
        {!effectsReady ? (
          <Text role="alert" fontSize="12.5px" color="studio.fgMuted">
            Pick a text style or a sound effect, or there is nothing to apply.
          </Text>
        ) : null}
      </Stack>

      {staleCount > 0 ? (
        <Flex role="alert" px="3" py="2.5" gap="3" align="center" justify="space-between" bg="studio.subtle" borderRadius="10px">
          <Text fontSize="12.5px" color="studio.danger" lineHeight="1.4">
            {staleCount} censored {staleCount === 1 ? "word no longer matches" : "words no longer match"} the transcript and will block export.
          </Text>
          <Button size="sm" h="28px" flexShrink={0} {...softButtonProps} fontSize="12.5px" onClick={() => setReviewOpen(true)}>
            Review
          </Button>
        </Flex>
      ) : null}

      {suggestions.length === 0 ? (
        <PanelEmpty
          icon={<ShieldCheck size={18} />}
          title="No sensitive words found"
          actions={
            <>
              {censoredCount > 0 ? (
                <Button size="sm" h="32px" {...softButtonProps} fontSize="13px" onClick={() => setReviewOpen(true)}>
                  Review censored words ({censoredCount})
                </Button>
              ) : null}
              <Button size="sm" h="32px" {...softButtonProps} fontSize="13px" onClick={() => setWordsOpen(true)}>
                Edit word list
              </Button>
            </>
          }
        >
          Nothing in this clip's transcript matches your word list.
        </PanelEmpty>
      ) : (
        <Stack gap="3">
          <Text fontSize="13px" color="studio.fgMuted" fontVariantNumeric="tabular-nums" aria-live="polite">
            {suggestions.length} {suggestions.length === 1 ? "match" : "matches"} found
            {censoredCount > 0 ? ` · ${censoredCount} censored` : ""}
          </Text>
          <PanelButton
            disabled={pending.length === 0 || !effectsReady}
            title={pending.length === 0 && effectsReady ? "Every match already looks and sounds like this" : undefined}
            onClick={applyAll}
          >
            {pending.length === 0
              ? untimed.length === suggestions.length ? "Nothing to apply" : "All matches censored"
              : `Apply to ${pending.length} ${pending.length === 1 ? "word" : "words"}`}
            {applyLock?.tier && pending.length > 0 ? <StudioLockGem tier={applyLock.tier} /> : null}
          </PanelButton>
          {applyLock?.tier ? (
            <Text fontSize="12.5px" color="studio.fgMuted">
              Scanning is free. Saving censor edits needs {PLAN_CATALOG[applyLock.tier].name}.
            </Text>
          ) : null}
          {untimed.length > 0 ? (
            <Text fontSize="12.5px" color="studio.fgMuted">
              {untimed.length} {untimed.length === 1 ? "match has" : "matches have"} no word timing and can't be censored.
            </Text>
          ) : null}
          <Flex gap="2">
            <Button flex="1" h="36px" {...softButtonProps} fontSize="13px" onClick={() => setReviewOpen(true)}>
              Review matches
            </Button>
            <Button flex="1" h="36px" {...softButtonProps} fontSize="13px" onClick={() => setWordsOpen(true)}>
              Edit word list
            </Button>
          </Flex>
        </Stack>
      )}

      {reviewOpen ? (
        <AutoCensorReviewDrawer
          suggestions={suggestions}
          effects={effects}
          onApply={apply}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
      <CensorWordListDialog
        open={wordsOpen}
        onOpenChange={setWordsOpen}
        tone="studio"
        workspace={{
          words: workspaceList.words,
          customized: workspaceList.customized,
          canEdit: autoCensorPolicy.canEditWorkspaceTerms,
          save: replaceWorkspaceCensorWords,
          reset: resetWorkspaceCensorWords,
          onChange: (workspace) => setCensorWords((current) => ({ ...current, workspace })),
        }}
        project={{
          terms: projectTerms,
          canEdit: true,
          save: async (terms) => {
            const result = await updateProjectCensorTerms(terms);
            const payload = result && typeof result === "object" ? result as { terms?: unknown } : null;
            if (!payload || !Array.isArray(payload.terms)) throw new Error("Try again. Your list is unchanged.");
            return payload.terms.filter((term): term is string => typeof term === "string");
          },
        }}
        onProjectTermsChange={(project) => setCensorWords((current) => ({ ...current, project }))}
        brandTerms={autoCensorPolicy.brandTerms}
        locale={autoCensorPolicy.locale}
      />
    </Stack>
  );
}
