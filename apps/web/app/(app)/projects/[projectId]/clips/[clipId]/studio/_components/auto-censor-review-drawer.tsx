"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Box, Button, Checkbox, Flex, Input, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { Check, Plus, Search, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorWordId,
  detectAutoCensorSuggestions,
  isCensorSegmentStale,
  lowestTierWithFeature,
  PLAN_CATALOG,
  type AutoCensorSuggestion,
  type AutoCensorTreatment,
  type CensorSegment,
} from "@narriflow/validators";
import { formatTimecode } from "@/lib/format";
import { useStudio } from "./studio-shell";
import {
  autoCensorResultCountBucket,
  autoCensorSourceSpanKey,
  buildReviewedCensorSegments,
  type AutoCensorReviewDecision,
} from "./auto-censor-review-model";
import { PanelButton, SectionLabel, chipProps, softButtonProps, softFieldProps, softFocusWithin } from "./tool-panels/panel-ui";

const TREATMENT_LABEL: Record<AutoCensorTreatment, string> = {
  caption_mask: "Mask captions",
  mute: "Mute dialogue",
  beep: "Bleep",
};

function sourceLabel(source: AutoCensorSuggestion["policySource"]) {
  if (source === "brand_profile") return "Brand";
  return source === "project" ? "Project" : "Built-in";
}

function treatmentSettings(
  segment: CensorSegment,
  treatment: AutoCensorTreatment,
): CensorSegment {
  return {
    ...segment,
    treatment,
    beepSettings: treatment === "beep"
      ? segment.beepSettings ?? { frequencyHz: 1_000, levelDb: -8 }
      : null,
    captionMaskPolicy: treatment === "caption_mask"
      ? segment.captionMaskPolicy ?? {
          replacement: "first_character",
          preservePunctuation: true,
        }
      : null,
  };
}

function TreatmentSelect({
  value,
  onChange,
  availability,
  disabled = false,
}: {
  value: AutoCensorTreatment;
  onChange: (value: AutoCensorTreatment) => void;
  availability: Readonly<Record<AutoCensorTreatment, boolean>>;
  disabled?: boolean;
}) {
  return (
    <NativeSelect.Root w="auto" flexShrink={0} disabled={disabled}>
      <NativeSelect.Field
        aria-label="Censor treatment"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as AutoCensorTreatment)}
        h="32px"
        ps="3"
        pe="8"
        bg="studio.raised"
        borderWidth="0"
        borderRadius="8px"
        color="studio.fg"
        fontSize="13px"
      >
        {(Object.keys(TREATMENT_LABEL) as AutoCensorTreatment[]).map((treatment) => (
          <option key={treatment} value={treatment} disabled={!availability[treatment]}>
            {TREATMENT_LABEL[treatment]}{availability[treatment] ? "" : " — soon"}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator color="studio.fgMuted" />
    </NativeSelect.Root>
  );
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

export function AutoCensorReviewDrawer({ onClose }: { onClose: () => void }) {
  const {
    editorDocument,
    editorRevision,
    utterances,
    clipWindow,
    autoCensorPolicy,
    setCensorSegments,
    updateProjectCensorTerms,
    recordAutoCensorEvent,
  } = useStudio("editorDocument", "editorRevision", "utterances", "clipWindow", "autoCensorPolicy", "setCensorSegments", "updateProjectCensorTerms", "recordAutoCensorEvent");
  const availableTreatment = (Object.keys(autoCensorPolicy.treatments) as AutoCensorTreatment[])
    .find((treatment) => autoCensorPolicy.treatments[treatment]);
  const firstTreatment = availableTreatment ?? "caption_mask";
  const hasWritableTreatment = availableTreatment !== undefined;
  const [defaultTreatment, setDefaultTreatment] = useState<AutoCensorTreatment>(firstTreatment);
  const [suggestions, setSuggestions] = useState<AutoCensorSuggestion[]>([]);
  const [decisions, setDecisions] = useState<AutoCensorReviewDecision[]>([]);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | AutoCensorSuggestion["policySource"]>("all");
  const [projectTerms, setProjectTerms] = useState([...autoCensorPolicy.projectTerms]);
  const [termDraft, setTermDraft] = useState("");
  const [savingTerms, setSavingTerms] = useState(false);

  const recordEventBestEffort = (input: Parameters<typeof recordAutoCensorEvent>[0]) => {
    void recordAutoCensorEvent(input).catch(() => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "auto_censor_analytics_failed",
        eventType: input.type,
      }));
    });
  };

  const runScan = (terms: readonly string[] = projectTerms, treatment = defaultTreatment) => {
    recordEventBestEffort({ type: "auto_censor_scan_started" });
    const result = detectAutoCensorSuggestions({
      documentRevision: editorRevision,
      locale: autoCensorPolicy.locale,
      clipWindow,
      deletedRanges: editorDocument.deletedRanges,
      transcript: utterances,
      brandTerms: autoCensorPolicy.brandTerms,
      projectTerms: terms,
      defaultTreatment: treatment,
      paddingSec: 0.06,
    });
    setSuggestions(result);
    setDecisions(result.map((suggestion) => {
      const applied = editorDocument.censorSegments.find(
        (segment) => autoCensorSourceSpanKey(segment.sourceWordIds) ===
          autoCensorSourceSpanKey(suggestion.sourceWordIds),
      );
      const treatmentForSuggestion = suggestion.timingLimitation
        ? "caption_mask"
        : treatment;
      return {
        fingerprint: suggestion.fingerprint,
        selected: suggestion.timingLimitation === null &&
          !applied &&
          autoCensorPolicy.treatments[treatmentForSuggestion],
        treatment: applied?.treatment ?? treatmentForSuggestion,
      };
    }));
    recordEventBestEffort({
      type: "auto_censor_scan_completed",
      resultCountBucket: autoCensorResultCountBucket(result.length),
    });
  };

  // Opening the drawer always scans the current corrected transcript. No
  // editor action is dispatched until Apply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the drawer mount is the explicit scan gesture; later rescans are invoked after project-term changes.
  useEffect(() => {
    runScan(autoCensorPolicy.projectTerms, firstTreatment);
  }, []);

  const decisionByFingerprint = useMemo(
    () => new Map(decisions.map((decision) => [decision.fingerprint, decision])),
    [decisions],
  );
  const suggestionByFingerprint = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.fingerprint, suggestion])),
    [suggestions],
  );
  const appliedSourceSpans = useMemo(
    () => new Set(editorDocument.censorSegments.map((segment) =>
      autoCensorSourceSpanKey(segment.sourceWordIds),
    )),
    [editorDocument.censorSegments],
  );
  const visibleSuggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return suggestions.filter((suggestion) =>
      (sourceFilter === "all" || suggestion.policySource === sourceFilter) &&
      (!normalizedQuery || suggestion.matchedText.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, sourceFilter, suggestions]);
  const selectedCount = suggestions.filter((suggestion) => {
    const decision = decisionByFingerprint.get(suggestion.fingerprint);
    return decision?.selected &&
      suggestion.timingLimitation === null &&
      autoCensorPolicy.treatments[decision.treatment] &&
      !appliedSourceSpans.has(autoCensorSourceSpanKey(suggestion.sourceWordIds));
  }).length;

  const updateDecision = (
    fingerprint: string,
    update: Partial<Omit<AutoCensorReviewDecision, "fingerprint">>,
  ) => setDecisions((current) => current.map((decision) =>
    decision.fingerprint === fingerprint ? { ...decision, ...update } : decision,
  ));

  const saveTerms = async (nextTerms: string[]) => {
    setSavingTerms(true);
    try {
      const result = await updateProjectCensorTerms(nextTerms);
      const payload = result && typeof result === "object"
        ? result as { terms?: unknown; kind?: string }
        : null;
      if (!payload || !Array.isArray(payload.terms)) throw new Error("term_save_failed");
      const saved = payload.terms.filter((term): term is string => typeof term === "string");
      setProjectTerms(saved);
      runScan(saved);
    } catch {
      toaster.create({
        type: "error",
        title: "Word list not saved",
        description: "Try again. Your current review is unchanged.",
      });
    } finally {
      setSavingTerms(false);
    }
  };

  const addProjectTerm = () => {
    const term = termDraft.trim();
    if (!term) return;
    setTermDraft("");
    void saveTerms([...projectTerms, term]);
  };

  const apply = () => {
    try {
      const result = buildReviewedCensorSegments({
        suggestions,
        decisions,
        existing: editorDocument.censorSegments,
        canApply: autoCensorPolicy.canApply,
        treatments: autoCensorPolicy.treatments,
        paddingSec: 0.06,
        createId: () => crypto.randomUUID(),
      });
      if (result.applied.length === 0) return;
      if (!setCensorSegments(result.segments)) {
        throw new Error("auto_censor_document_rejected");
      }
      const staleCount = editorDocument.censorSegments.filter((segment) =>
        isCensorSegmentStale(segment, utterances),
      ).length;
      recordEventBestEffort({
        type: "auto_censor_applied",
        selectedCount: result.applied.length,
        captionMaskCount: result.applied.filter((segment) => segment.treatment === "caption_mask").length,
        muteCount: result.applied.filter((segment) => segment.treatment === "mute").length,
        beepCount: result.applied.filter((segment) => segment.treatment === "beep").length,
        staleCount,
      });
      setDecisions((current) => current.map((decision) => ({ ...decision, selected: false })));
      toaster.create({
        type: "success",
        title: `${result.applied.length} censor ${result.applied.length === 1 ? "edit" : "edits"} applied`,
        description: "Undo restores the clip in one step.",
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "auto_censor_apply_failed";
      console.warn(JSON.stringify({
        level: "warn",
        message: "auto_censor_apply_failed",
        code,
      }));
      const entitlementRequired = code === "plan_feature_required";
      toaster.create({
        type: "error",
        title: entitlementRequired
          ? "Upgrade to apply Auto Censor"
          : "Auto Censor was not applied",
        description: entitlementRequired
          ? `Scanning is included. Applying edits is available on ${PLAN_CATALOG[lowestTierWithFeature("editor.censoring") ?? "creator"].name} and above.`
          : process.env.NODE_ENV === "development"
            ? code
            : "Your review is unchanged. Try again.",
      });
    }
  };

  const updateApplied = (id: string, update: (segment: CensorSegment) => CensorSegment) => {
    setCensorSegments(editorDocument.censorSegments.map((segment) =>
      segment.id === id ? update(segment) : segment,
    ));
  };

  const reviewStale = (segment: CensorSegment) => {
    const sourceWordIds = utterances.flatMap((utterance) => utterance.words.flatMap((word, wordIndex) =>
      word.endSec > segment.sourceStartSec && word.startSec < segment.sourceEndSec
        ? [autoCensorWordId({ utteranceIndex: utterance.index, wordIndex, word })]
        : [],
    ));
    if (sourceWordIds.length === 0) return;
    updateApplied(segment.id, (current) => ({
      ...current,
      sourceWordIds,
      suggestionFingerprint: null,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
    }));
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
        layerStyle="panel"
      >
        <Box px="6" pt="5" pb="4" flexShrink={0}>
          <Flex align="center" justify="space-between" gap="3">
            <Text id="auto-censor-title" fontSize="18px" fontWeight="500">
              Review sensitive words
            </Text>
            <RoundIconButton label="Close Auto Censor" onClick={onClose}>
              <X size={17} />
            </RoundIconButton>
          </Flex>
          <Text mt="1" fontSize="13px" color="studio.fgMuted" fontVariantNumeric="tabular-nums">
            {suggestions.length} found · {selectedCount} selected ·{" "}
            {editorDocument.censorSegments.length} applied
          </Text>

          <Flex gap="2" mt="5">
            <Flex flex="1" align="center" gap="2" px="3" h="40px" {...softFieldProps} color="studio.fgMuted" _focusWithin={softFocusWithin}>
              <Search size={15} />
              <Input
                aria-label="Filter sensitive word matches"
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
            <Flex align="center">
              <TreatmentSelect disabled={!hasWritableTreatment} value={defaultTreatment} availability={autoCensorPolicy.treatments} onChange={(value) => {
                setDefaultTreatment(value);
                setDecisions((current) => current.map((decision) => ({
                  ...decision,
                  treatment: suggestionByFingerprint.get(decision.fingerprint)?.timingLimitation
                    ? "caption_mask"
                    : value,
                })));
              }} />
            </Flex>
          </Flex>
          <Flex gap="2" mt="3" flexWrap="wrap">
            {(["all", "built_in", "brand_profile", "project"] as const).map((source) => (
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
          <Box pt="2" pb="6">
            <SectionLabel
              action={
                <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums">
                  {projectTerms.length}/50
                </Text>
              }
            >
              Project words
            </SectionLabel>
            <Flex gap="2">
              <Input
                value={termDraft}
                onChange={(event) => setTermDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addProjectTerm(); }}
                h="40px"
                px="3"
                fontSize="14px"
                {...softFieldProps}
                placeholder="Add a word or phrase"
              />
              <Button
                aria-label="Add project word"
                {...softButtonProps}
                w="40px"
                minW="40px"
                h="40px"
                p="0"
                loading={savingTerms}
                onClick={addProjectTerm}
              >
                <Plus size={16} />
              </Button>
            </Flex>
            {projectTerms.length > 0 && (
              <Flex mt="3" gap="2" flexWrap="wrap">
                {projectTerms.map((term) => (
                  <Flex
                    key={term}
                    as="button"
                    aria-label={`Remove ${term}`}
                    align="center"
                    gap="1.5"
                    h="30px"
                    px="2.5"
                    borderRadius="8px"
                    bg="studio.raised"
                    border="none"
                    color="studio.fg"
                    fontSize="13px"
                    cursor="pointer"
                    _hover={{ bg: "studio.borderStrong" }}
                    onClick={() => void saveTerms(projectTerms.filter((candidate) => candidate !== term))}
                  >
                    {term}
                    <X size={12} />
                  </Flex>
                ))}
              </Flex>
            )}
          </Box>

          <SectionLabel
            action={
              <Flex gap="4">
                <TextAction onClick={() => setDecisions((current) => current.map((decision) => ({
                  ...decision,
                  selected: suggestionByFingerprint.get(decision.fingerprint)?.timingLimitation === null &&
                    autoCensorPolicy.treatments[decision.treatment] &&
                    !appliedSourceSpans.has(autoCensorSourceSpanKey(
                      suggestionByFingerprint.get(decision.fingerprint)?.sourceWordIds ?? [],
                    )),
                })))}>Select all</TextAction>
                <TextAction onClick={() => setDecisions((current) => current.map((decision) => ({ ...decision, selected: false })))}>Clear</TextAction>
              </Flex>
            }
          >
            Suggestions
          </SectionLabel>

          {visibleSuggestions.length === 0 ? (
            <Stack py="10" align="center" textAlign="center" gap="1.5">
              <Box color="studio.fgSubtle" mb="1"><Check size={20} /></Box>
              <Text fontSize="14px" fontWeight="500">No matching suggestions</Text>
              <Text fontSize="13px" color="studio.fgMuted">The scan completed successfully.</Text>
            </Stack>
          ) : (
            <Stack gap="2">
              {visibleSuggestions.map((suggestion) => {
                const decision = decisionByFingerprint.get(suggestion.fingerprint)!;
                const alreadyApplied = appliedSourceSpans.has(
                  autoCensorSourceSpanKey(suggestion.sourceWordIds),
                );
                const treatmentUnavailable = !autoCensorPolicy.treatments[decision.treatment];
                return (
                  <Flex key={suggestion.fingerprint} p="3" gap="3" bg="studio.subtle" borderRadius="10px">
                    <Checkbox.Root size="sm" colorPalette="accent" disabled={alreadyApplied || treatmentUnavailable || suggestion.timingLimitation !== null} checked={decision.selected} onCheckedChange={(event) => updateDecision(suggestion.fingerprint, { selected: Boolean(event.checked) })} mt="3px">
                      <Checkbox.HiddenInput /><Checkbox.Control />
                    </Checkbox.Root>
                    <Box minW="0" flex="1">
                      <Flex align="baseline" justify="space-between" gap="2">
                        <Text fontSize="14px" fontWeight="600" truncate>{suggestion.matchedText}</Text>
                        <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums" flexShrink={0}>{suggestion.sourceStartSec === null ? "No timing" : formatTimecode(suggestion.sourceStartSec)}</Text>
                      </Flex>
                      <Text mt="0.5" fontSize="13px" color="studio.fgMuted" lineHeight="1.5" lineClamp="2">{suggestion.contextBefore} <Text as="span" color="studio.fg" fontWeight="600">{suggestion.matchedText}</Text> {suggestion.contextAfter}</Text>
                      <Flex mt="2.5" align="center" justify="space-between" gap="2">
                        <Text fontSize="12px" color="studio.fgSubtle">{alreadyApplied ? "Applied · " : ""}{sourceLabel(suggestion.policySource)} · {suggestion.confidence === null ? "No confidence" : `${Math.round(suggestion.confidence * 100)}%`}</Text>
                        <TreatmentSelect disabled={alreadyApplied || !hasWritableTreatment || suggestion.timingLimitation !== null} value={decision.treatment} availability={autoCensorPolicy.treatments} onChange={(value) => updateDecision(suggestion.fingerprint, { treatment: value, selected: true })} />
                      </Flex>
                      {suggestion.timingLimitation && <Text mt="2" fontSize="12px" color="studio.fgMuted">Audio unavailable — caption mask only</Text>}
                    </Box>
                  </Flex>
                );
              })}
            </Stack>
          )}

          {editorDocument.censorSegments.length > 0 && (
            <Box pt="6">
              <SectionLabel>Applied segments</SectionLabel>
              <Stack gap="2">
                {editorDocument.censorSegments.map((segment) => {
                  const stale = isCensorSegmentStale(segment, utterances);
                  return (
                    <Flex key={segment.id} p="3" gap="3" align="center" bg="studio.subtle" borderRadius="10px">
                      <Checkbox.Root size="sm" colorPalette="accent" checked={segment.enabled} onCheckedChange={(event) => updateApplied(segment.id, (current) => ({ ...current, enabled: Boolean(event.checked) }))}><Checkbox.HiddenInput /><Checkbox.Control /></Checkbox.Root>
                      <Flex flex="1" minW="0" align="center" gap="2">
                        <Text fontSize="13px" color="studio.fgMuted" fontVariantNumeric="tabular-nums">{formatTimecode(segment.sourceStartSec)}</Text>
                        {stale && <Text fontSize="12px" fontWeight="500" color="studio.danger">Stale</Text>}
                      </Flex>
                      <TreatmentSelect value={segment.treatment} availability={autoCensorPolicy.treatments} onChange={(value) => updateApplied(segment.id, (current) => treatmentSettings(current, value))} />
                      {stale && <Button size="sm" h="32px" {...softButtonProps} fontSize="13px" onClick={() => reviewStale(segment)}>Review</Button>}
                      <RoundIconButton label="Delete censor segment" onClick={() => setCensorSegments(editorDocument.censorSegments.filter((candidate) => candidate.id !== segment.id))}>
                        <X size={15} />
                      </RoundIconButton>
                    </Flex>
                  );
                })}
              </Stack>
            </Box>
          )}
        </Box>

        <Box px="6" py="5" borderTopWidth="1px" borderColor="studio.border" flexShrink={0}>
          {!autoCensorPolicy.canApply && <Text mb="3" fontSize="13px" color="studio.fgMuted">Preview is free. Upgrade to Creator to save censor edits.</Text>}
          {autoCensorPolicy.canApply && !hasWritableTreatment && <Text mb="3" fontSize="13px" color="studio.fgMuted">Scanning is available. Applying censor edits is temporarily unavailable.</Text>}
          <PanelButton disabled={!autoCensorPolicy.canApply || !hasWritableTreatment || selectedCount === 0} onClick={apply}>
            Apply {selectedCount > 0 ? selectedCount : "selected"} {selectedCount === 1 ? "edit" : "edits"}
          </PanelButton>
        </Box>
      </Flex>
    </>
  );
}
