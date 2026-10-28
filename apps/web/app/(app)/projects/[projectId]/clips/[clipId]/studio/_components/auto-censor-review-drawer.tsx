"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Box, Button, Checkbox, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Search, X } from "lucide-react";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorWordId,
  buildClipCutPlan,
  isCensorSegmentStale,
  maskCensorTermForDisplay,
  sourceToEdited,
  PLAN_CATALOG,
  type AutoCensorSuggestion,
  type CensorSegment,
} from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "./studio-shell";
import { StudioLockGem } from "./studio-lock-gem";
import {
  AUTO_CENSOR_SOUNDS,
  AUTO_CENSOR_TEXT_STYLES,
  autoCensorEffectsValid,
  censorWordIdsInRange,
  groupAppliedCensorSegments,
  hasCensorChanges,
  censorChanges,
  type AppliedCensorGroup,
  type AutoCensorEffects,
} from "./auto-censor-review-model";
import { PanelButton, SectionLabel, chipProps, softButtonProps, softFieldProps, softFocusWithin } from "./tool-panels/panel-ui";

function sourceLabel(source: AutoCensorSuggestion["policySource"]) {
  if (source === "brand_profile") return "Brand";
  return source === "project" ? "Project" : "Workspace";
}

export function effectsSummary(effects: AutoCensorEffects) {
  const style = AUTO_CENSOR_TEXT_STYLES.find((option) => option.value === effects.textStyle);
  const sound = AUTO_CENSOR_SOUNDS.find((option) => option.value === effects.sound);
  return [
    effects.textStyle === "none" ? null : style?.label,
    effects.sound === "none" ? null : sound?.label,
  ].filter(Boolean).join(" · ");
}

function groupSummary(group: AppliedCensorGroup) {
  const style = group.maskPolicy
    ? AUTO_CENSOR_TEXT_STYLES.find((option) => option.value === group.maskPolicy?.replacement)?.label
    : null;
  const sound = group.sound ? AUTO_CENSOR_SOUNDS.find((option) => option.value === group.sound)?.label : null;
  return [style, sound].filter(Boolean).join(" · ");
}

/** Quiet text action, e.g. "Select all". */
function TextAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Box
      as="button"
      bg="transparent"
      border="none"
      p="0"
      color="studio.fgMuted"
      fontSize="13px"
      fontWeight="500"
      cursor="pointer"
      _hover={{ color: "studio.fg" }}
      onClick={onClick}
    >
      {children}
    </Box>
  );
}

function RoundIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Flex
      as="button"
      aria-label={label}
      align="center"
      justify="center"
      w="32px"
      h="32px"
      flexShrink={0}
      borderRadius="full"
      bg="transparent"
      border="none"
      color="studio.fgMuted"
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease"
      _hover={{ color: "studio.fg", bg: "studio.raised" }}
      onClick={onClick}
    >
      {children}
    </Flex>
  );
}

/**
 * The per-match review behind the Auto-censor panel: pick which matches to
 * censor, and manage the ones already applied. How a match is censored comes
 * from the panel; nothing here is per-row.
 */
export function AutoCensorReviewDrawer({
  suggestions,
  effects,
  onApply,
  onClose,
}: {
  suggestions: readonly AutoCensorSuggestion[];
  effects: AutoCensorEffects;
  /** Censors these matches with the panel's style and sound. */
  onApply: (matches: readonly AutoCensorSuggestion[]) => void;
  onClose: () => void;
}) {
  const { editorDocument, utterances, autoCensorPolicy, setCensorSegments, upgradePrompts } = useStudio(
    "editorDocument", "utterances", "autoCensorPolicy", "setCensorSegments", "upgradePrompts",
  );
  const { openUpgrade } = useUpgrade();
  const applyLock = autoCensorPolicy.canApply ? null : upgradePrompts.censoring;
  const existing = editorDocument.censorSegments;
  const effectsReady = autoCensorEffectsValid(effects);

  const pendingFingerprints = useMemo(
    () => new Set(suggestions
      .filter((suggestion) => hasCensorChanges(censorChanges(suggestion, existing, effects)))
      .map((suggestion) => suggestion.fingerprint)),
    [suggestions, existing, effects],
  );
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | AutoCensorSuggestion["policySource"]>("all");

  const isSelected = (fingerprint: string) =>
    pendingFingerprints.has(fingerprint) && !deselected.has(fingerprint);
  const selectedMatches = suggestions.filter((suggestion) => isSelected(suggestion.fingerprint));
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return suggestions.filter((suggestion) =>
      (sourceFilter === "all" || suggestion.policySource === sourceFilter) &&
      (!normalizedQuery || suggestion.matchedText.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, sourceFilter, suggestions]);
  const groups = useMemo(() => groupAppliedCensorSegments(existing), [existing]);
  // Times read on the clip's own timeline (what the player and timeline show),
  // not the source video's.
  const { clipStartSec, clipEndSec, deletedRanges } = editorDocument;
  const cutMap = useMemo(
    () => buildClipCutPlan([...deletedRanges], { startSec: clipStartSec, endSec: clipEndSec }).map,
    [clipEndSec, clipStartSec, deletedRanges],
  );
  const clipTime = (sourceSec: number) => formatDuration(sourceToEdited(cutMap, sourceSec));
  // An applied word's text, so a row names what it censors.
  const wordText = useMemo(() => {
    const byId = new Map<string, string>();
    for (const utterance of utterances) {
      utterance.words.forEach((word, wordIndex) => {
        byId.set(autoCensorWordId({ utteranceIndex: utterance.index, wordIndex, word }), word.word);
      });
    }
    return byId;
  }, [utterances]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggle = (fingerprint: string, selected: boolean) =>
    setDeselected((current) => {
      const next = new Set(current);
      if (selected) next.delete(fingerprint);
      else next.add(fingerprint);
      return next;
    });

  const updateGroup = (group: AppliedCensorGroup, update: (segment: CensorSegment) => CensorSegment) => {
    const ids = new Set(group.segmentIds);
    setCensorSegments(existing.map((segment) => ids.has(segment.id) ? update(segment) : segment));
  };

  const reviewStale = (group: AppliedCensorGroup) => {
    const first = existing.find((segment) => group.segmentIds.includes(segment.id));
    if (!first) return;
    const sourceWordIds = censorWordIdsInRange(utterances, {
      startSec: first.sourceStartSec,
      endSec: first.sourceEndSec,
    });
    if (sourceWordIds.length === 0) return;
    updateGroup(group, (segment) => ({
      ...segment,
      sourceWordIds,
      suggestionFingerprint: null,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
    }));
  };

  const applySelected = () => {
    if (selectedMatches.length === 0 || !effectsReady) return;
    if (applyLock?.tier) openUpgrade(applyLock);
    else onApply(selectedMatches);
  };

  return (
    <>
      <Box position="fixed" inset="0" bg="blackAlpha.700" zIndex={190} onClick={onClose} />
      <Flex
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-censor-title"
        position="fixed"
        insetBlock="0"
        right="0"
        w={{ base: "100vw", md: "460px" }}
        bg="studio.surface"
        color="studio.fg"
        zIndex={200}
        direction="column"
        borderRadius="l3"
      >
        <Box px="6" pt="5" pb="4" flexShrink={0}>
          <Flex align="center" justify="space-between" gap="3">
            <Text id="auto-censor-title" fontSize="18px" fontWeight="500">
              Review matches
            </Text>
            <RoundIconButton label="Close review" onClick={onClose}>
              <X size={17} />
            </RoundIconButton>
          </Flex>
          <Text mt="1" fontSize="13px" color="studio.fgMuted" fontVariantNumeric="tabular-nums">
            {suggestions.length} found · {selectedMatches.length} selected · {groups.length} censored
          </Text>
          <Text mt="0.5" fontSize="13px" color="studio.fgSubtle">
            {effectsReady
              ? `Applies ${effectsSummary(effects)}. Change it in the Auto-censor panel.`
              : "Choose a text style or a sound in the Auto-censor panel first."}
          </Text>

          <Flex mt="5" align="center" gap="2" px="3" h="40px" {...softFieldProps} color="studio.fgMuted" _focusWithin={softFocusWithin}>
            <Search size={15} />
            <Input
              aria-label="Filter matches"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              border="0"
              p="0"
              h="full"
              bg="transparent"
              color="studio.fg"
              fontSize="14px"
              _placeholder={{ color: "studio.fgSubtle" }}
              _focusVisible={{ outline: "none", boxShadow: "none" }}
              placeholder="Filter matches"
            />
          </Flex>
          <Flex gap="2" mt="3" flexWrap="wrap">
            {(["all", "workspace", "brand_profile", "project"] as const).map((source) => (
              <Box
                key={source}
                as="button"
                aria-pressed={sourceFilter === source}
                cursor="pointer"
                {...chipProps(sourceFilter === source)}
                onClick={() => setSourceFilter(source)}
              >
                {source === "all" ? "All sources" : sourceLabel(source)}
              </Box>
            ))}
          </Flex>
        </Box>

        <Box flex="1" overflowY="auto" px="6" pb="6">
          <SectionLabel
            action={
              <Flex gap="4">
                <TextAction onClick={() => setDeselected(new Set())}>Select all</TextAction>
                <TextAction onClick={() => setDeselected(new Set(suggestions.map((suggestion) => suggestion.fingerprint)))}>Clear</TextAction>
              </Flex>
            }
          >
            Matches
          </SectionLabel>

          {visible.length === 0 ? (
            <Stack py="10" align="center" textAlign="center" gap="1.5">
              <Box color="studio.fgSubtle" mb="1"><Check size={20} /></Box>
              <Text fontSize="14px" fontWeight="500">
                {suggestions.length === 0 ? "No sensitive words found" : "No matches for this filter"}
              </Text>
              <Text fontSize="13px" color="studio.fgMuted">
                {suggestions.length === 0 ? "The scan completed successfully." : "Try another source or search."}
              </Text>
            </Stack>
          ) : (
            <Stack gap="2">
              {visible.map((suggestion) => {
                const untimed = suggestion.timingLimitation !== null;
                const pending = pendingFingerprints.has(suggestion.fingerprint);
                return (
                  <Flex key={suggestion.fingerprint} p="3" gap="3" bg="studio.subtle" borderRadius="10px">
                    <Checkbox.Root
                      size="sm"
                      colorPalette="accent"
                      disabled={!pending}
                      checked={isSelected(suggestion.fingerprint)}
                      onCheckedChange={(event) => toggle(suggestion.fingerprint, Boolean(event.checked))}
                      mt="3px"
                    >
                      <Checkbox.HiddenInput /><Checkbox.Control />
                    </Checkbox.Root>
                    <Box minW="0" flex="1">
                      <Flex align="baseline" justify="space-between" gap="2">
                        <Text fontSize="14px" fontWeight="600" truncate>{suggestion.matchedText}</Text>
                        <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums" flexShrink={0}>
                          {suggestion.sourceStartSec === null ? "No timing" : clipTime(suggestion.sourceStartSec)}
                        </Text>
                      </Flex>
                      <Text mt="0.5" fontSize="13px" color="studio.fgMuted" lineHeight="1.5" lineClamp="2">
                        {suggestion.contextBefore} <Text as="span" color="studio.fg" fontWeight="600">{suggestion.matchedText}</Text> {suggestion.contextAfter}
                      </Text>
                      <Text mt="2" fontSize="12px" color="studio.fgSubtle">
                        {!pending && !untimed ? "Censored · " : ""}
                        {sourceLabel(suggestion.policySource)}
                        {suggestion.policyCategory === "slur" ? " · Slur" : ""}
                        {" · "}
                        {suggestion.confidence === null ? "No confidence" : `${Math.round(suggestion.confidence * 100)}%`}
                      </Text>
                      {untimed ? (
                        <Text mt="1.5" fontSize="12px" color="studio.fgMuted">
                          No word timing, so this one can't be censored. Correct the word in the transcript instead.
                        </Text>
                      ) : null}
                    </Box>
                  </Flex>
                );
              })}
            </Stack>
          )}

          {groups.length > 0 && (
            <Box pt="6">
              <SectionLabel>Censored words</SectionLabel>
              <Stack gap="2">
                {groups.map((group) => {
                  const stale = existing.some((segment) =>
                    group.segmentIds.includes(segment.id) && isCensorSegmentStale(segment, utterances));
                  return (
                    <Flex key={group.key} p="3" gap="3" align="center" bg="studio.subtle" borderRadius="10px">
                      <Checkbox.Root
                        size="sm"
                        colorPalette="accent"
                        checked={group.enabled}
                        onCheckedChange={(event) => {
                          // Turning a word off is cleanup any plan may save; turning one on is not.
                          if (event.checked && applyLock?.tier) openUpgrade(applyLock);
                          else if (!event.checked || autoCensorPolicy.canApply) {
                            updateGroup(group, (segment) => ({ ...segment, enabled: Boolean(event.checked) }));
                          }
                        }}
                      >
                        <Checkbox.HiddenInput /><Checkbox.Control />
                      </Checkbox.Root>
                      <Flex flex="1" minW="0" align="baseline" gap="2">
                        <Text fontSize="13px" color="studio.fgMuted" fontVariantNumeric="tabular-nums" flexShrink={0}>{clipTime(group.sourceStartSec)}</Text>
                        <Text fontSize="13px" fontWeight="600" color="studio.fg" flexShrink={0}>
                          {maskCensorTermForDisplay(group.sourceWordIds.map((id) => wordText.get(id) ?? "").join(" ").trim()) || "Word"}
                        </Text>
                        <Text fontSize="12px" color="studio.fgSubtle" truncate>{groupSummary(group)}</Text>
                        {stale && <Text fontSize="12px" fontWeight="500" color="studio.danger">Stale</Text>}
                      </Flex>
                      {stale && (
                        <Button
                          size="sm"
                          h="32px"
                          {...softButtonProps}
                          fontSize="13px"
                          aria-haspopup={applyLock?.tier && group.enabled ? "dialog" : undefined}
                          onClick={() => {
                            if (!autoCensorPolicy.canApply && group.enabled && applyLock?.tier) openUpgrade(applyLock);
                            else reviewStale(group);
                          }}
                        >
                          Review
                        </Button>
                      )}
                      <RoundIconButton
                        label="Remove censor"
                        onClick={() => {
                          const ids = new Set(group.segmentIds);
                          setCensorSegments(existing.filter((segment) => !ids.has(segment.id)));
                        }}
                      >
                        <X size={15} />
                      </RoundIconButton>
                    </Flex>
                  );
                })}
              </Stack>
            </Box>
          )}
        </Box>

        <Box px="6" py="5" flexShrink={0}>
          {applyLock?.tier ? (
            <Text mb="3" fontSize="13px" color="studio.fgMuted">
              Preview is free. Saving censor edits needs {PLAN_CATALOG[applyLock.tier].name}.
            </Text>
          ) : !autoCensorPolicy.canApply ? (
            <Text mb="3" fontSize="13px" color="studio.fgMuted">Preview is free. Saving censor edits isn't available.</Text>
          ) : null}
          <PanelButton disabled={selectedMatches.length === 0 || !effectsReady || (!applyLock?.tier && !autoCensorPolicy.canApply)} onClick={applySelected}>
            Apply to {selectedMatches.length > 0 ? selectedMatches.length : "selected"} {selectedMatches.length === 1 ? "word" : "words"}
            {applyLock?.tier ? <StudioLockGem tier={applyLock.tier} /> : null}
          </PanelButton>
        </Box>
      </Flex>
    </>
  );
}
