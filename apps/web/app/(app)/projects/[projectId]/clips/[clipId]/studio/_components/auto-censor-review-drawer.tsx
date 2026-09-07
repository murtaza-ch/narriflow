"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Button, Checkbox, Flex, Input, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { Check, Plus, Search, ShieldCheck, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorWordId,
  detectAutoCensorSuggestions,
  isCensorSegmentStale,
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
    <NativeSelect.Root size="xs" w="auto" disabled={disabled}>
      <NativeSelect.Field
        aria-label="Censor treatment"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as AutoCensorTreatment)}
        bg="studio.subtle"
        borderColor="studio.borderStrong"
        color="studio.fg"
        fontSize="11px"
      >
        {(Object.keys(TREATMENT_LABEL) as AutoCensorTreatment[]).map((treatment) => (
          <option key={treatment} value={treatment} disabled={!availability[treatment]}>
            {TREATMENT_LABEL[treatment]}{availability[treatment] ? "" : " — soon"}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
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
      const entitlementRequired = code === "auto_censor_entitlement_required";
      toaster.create({
        type: "error",
        title: entitlementRequired
          ? "Upgrade to apply Auto Censor"
          : "Auto Censor was not applied",
        description: entitlementRequired
          ? "Scanning is included. Applying edits is available on Creator and above."
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
        borderLeftWidth="1px"
        borderColor="studio.borderStrong"
        zIndex={200}
        direction="column"
        layerStyle="panel"
      >
        <Flex px="20px" py="16px" borderBottomWidth="1px" borderColor="studio.border" align="center" gap="12px">
          <Flex w="34px" h="34px" align="center" justify="center" borderWidth="1px" borderColor="studio.accent" color="studio.accentFg" borderRadius="l1">
            <ShieldCheck size={17} />
          </Flex>
          <Box flex="1">
            <Text id="auto-censor-title" textStyle="title" fontSize="16px">Review sensitive words</Text>
            <Text fontSize="11px" color="studio.fgMuted">Suggestions first. Nothing changes until you apply.</Text>
          </Box>
          <Button aria-label="Close Auto Censor" size="xs" variant="ghost" onClick={onClose}><X size={16} /></Button>
        </Flex>

        <Flex px="20px" py="10px" borderBottomWidth="1px" borderColor="studio.border" gap="18px">
          <Box><Text textStyle="data" fontSize="16px" color="studio.fg">{suggestions.length}</Text><Text textStyle="eyebrow" color="studio.fgSubtle">Found</Text></Box>
          <Box><Text textStyle="data" fontSize="16px" color="studio.fg">{selectedCount}</Text><Text textStyle="eyebrow" color="studio.fgSubtle">Selected</Text></Box>
          <Box><Text textStyle="data" fontSize="16px" color="studio.fg">{editorDocument.censorSegments.length}</Text><Text textStyle="eyebrow" color="studio.fgSubtle">Applied</Text></Box>
        </Flex>

        <Box px="20px" py="14px" borderBottomWidth="1px" borderColor="studio.border">
          <Flex gap="8px" mb="10px">
            <Flex flex="1" align="center" gap="7px" px="9px" borderWidth="1px" borderColor="studio.borderStrong" borderRadius="l1" bg="studio.subtle">
              <Search size={13} />
              <Input aria-label="Filter sensitive word matches" value={query} onChange={(event) => setQuery(event.target.value)} border="0" p="0" h="32px" fontSize="12px" placeholder="Filter matches" />
            </Flex>
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
          <Flex gap="5px" flexWrap="wrap">
            {(["all", "built_in", "brand_profile", "project"] as const).map((source) => (
              <Button key={source} size="xs" variant={sourceFilter === source ? "subtle" : "ghost"} onClick={() => setSourceFilter(source)}>
                {source === "all" ? "All sources" : sourceLabel(source)}
              </Button>
            ))}
          </Flex>
        </Box>

        <Box flex="1" overflowY="auto">
          <Box px="20px" py="14px" borderBottomWidth="1px" borderColor="studio.border">
            <Flex align="center" justify="space-between" mb="8px">
              <Text textStyle="eyebrow" color="studio.fgMuted">Project words</Text>
              <Text fontSize="10px" color="studio.fgSubtle">{projectTerms.length}/50</Text>
            </Flex>
            <Flex gap="6px">
              <Input value={termDraft} onChange={(event) => setTermDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addProjectTerm(); }} h="32px" fontSize="12px" borderColor="studio.borderStrong" placeholder="Add a word or phrase" />
              <Button aria-label="Add project word" size="sm" variant="outline" loading={savingTerms} onClick={addProjectTerm}><Plus size={14} /></Button>
            </Flex>
            {projectTerms.length > 0 && (
              <Flex mt="8px" gap="5px" flexWrap="wrap">
                {projectTerms.map((term) => (
                  <Button key={term} size="xs" variant="subtle" onClick={() => void saveTerms(projectTerms.filter((candidate) => candidate !== term))}>
                    {term} <X size={10} />
                  </Button>
                ))}
              </Flex>
            )}
          </Box>

          <Flex px="20px" py="9px" align="center" justify="space-between" borderBottomWidth="1px" borderColor="studio.border">
            <Text textStyle="eyebrow" color="studio.fgMuted">Suggestions</Text>
            <Flex gap="4px">
              <Button size="xs" variant="ghost" onClick={() => setDecisions((current) => current.map((decision) => ({
                ...decision,
                selected: suggestionByFingerprint.get(decision.fingerprint)?.timingLimitation === null &&
                  autoCensorPolicy.treatments[decision.treatment] &&
                  !appliedSourceSpans.has(autoCensorSourceSpanKey(
                    suggestionByFingerprint.get(decision.fingerprint)?.sourceWordIds ?? [],
                  )),
              })))}>Select all</Button>
              <Button size="xs" variant="ghost" onClick={() => setDecisions((current) => current.map((decision) => ({ ...decision, selected: false })))}>Clear</Button>
            </Flex>
          </Flex>

          {visibleSuggestions.length === 0 ? (
            <Stack px="20px" py="32px" align="center" textAlign="center" gap="7px">
              <Flex w="38px" h="38px" borderWidth="1px" borderColor="studio.borderStrong" borderRadius="l1" align="center" justify="center" color="studio.fgSubtle"><Check size={17} /></Flex>
              <Text fontSize="13px" fontWeight="600">No matching suggestions</Text>
              <Text fontSize="11px" color="studio.fgMuted">The scan completed successfully.</Text>
            </Stack>
          ) : visibleSuggestions.map((suggestion) => {
            const decision = decisionByFingerprint.get(suggestion.fingerprint)!;
            const alreadyApplied = appliedSourceSpans.has(
              autoCensorSourceSpanKey(suggestion.sourceWordIds),
            );
            const treatmentUnavailable = !autoCensorPolicy.treatments[decision.treatment];
            return (
              <Flex key={suggestion.fingerprint} px="20px" py="12px" gap="10px" borderBottomWidth="1px" borderColor="studio.border" borderLeftWidth="3px" borderLeftColor={decision.selected ? "studio.accent" : "studio.border"}>
                <Checkbox.Root disabled={alreadyApplied || treatmentUnavailable || suggestion.timingLimitation !== null} checked={decision.selected} onCheckedChange={(event) => updateDecision(suggestion.fingerprint, { selected: Boolean(event.checked) })} mt="2px">
                  <Checkbox.HiddenInput /><Checkbox.Control />
                </Checkbox.Root>
                <Box minW="0" flex="1">
                  <Flex align="center" justify="space-between" gap="8px">
                    <Text fontSize="13px" fontWeight="700" truncate>{suggestion.matchedText}</Text>
                    <Text textStyle="data" fontSize="10px" color="studio.timecode">{suggestion.sourceStartSec === null ? "UNTIMED" : formatTimecode(suggestion.sourceStartSec)}</Text>
                  </Flex>
                  <Text fontSize="11px" color="studio.fgMuted" lineClamp="2">{suggestion.contextBefore} <Text as="span" color="studio.fg" fontWeight="700">{suggestion.matchedText}</Text> {suggestion.contextAfter}</Text>
                  <Flex mt="7px" align="center" justify="space-between" gap="8px">
                    <Text textStyle="eyebrow" color="studio.fgSubtle">{alreadyApplied ? "Applied · " : ""}{sourceLabel(suggestion.policySource)} · {suggestion.confidence === null ? "No confidence" : `${Math.round(suggestion.confidence * 100)}%`}</Text>
                    <TreatmentSelect disabled={alreadyApplied || !hasWritableTreatment || suggestion.timingLimitation !== null} value={decision.treatment} availability={autoCensorPolicy.treatments} onChange={(value) => updateDecision(suggestion.fingerprint, { treatment: value, selected: true })} />
                  </Flex>
                  {suggestion.timingLimitation && <Text mt="5px" fontSize="10px" color="studio.accentFg">Audio unavailable — caption mask only</Text>}
                </Box>
              </Flex>
            );
          })}

          {editorDocument.censorSegments.length > 0 && (
            <Box>
              <Text px="20px" py="9px" textStyle="eyebrow" color="studio.fgMuted" borderBottomWidth="1px" borderColor="studio.border">Applied segments</Text>
              {editorDocument.censorSegments.map((segment) => {
                const stale = isCensorSegmentStale(segment, utterances);
                return (
                  <Flex key={segment.id} px="20px" py="11px" gap="9px" align="center" borderBottomWidth="1px" borderColor="studio.border" borderLeftWidth="3px" borderLeftColor={stale ? "studio.dangerBorder" : segment.enabled ? "studio.accent" : "studio.border"}>
                    <Checkbox.Root checked={segment.enabled} onCheckedChange={(event) => updateApplied(segment.id, (current) => ({ ...current, enabled: Boolean(event.checked) }))}><Checkbox.HiddenInput /><Checkbox.Control /></Checkbox.Root>
                    <Box flex="1">
                      <Flex gap="7px" align="center"><Text textStyle="data" fontSize="10px" color="studio.timecode">{formatTimecode(segment.sourceStartSec)}</Text>{stale && <Text textStyle="eyebrow" color="studio.danger">Stale</Text>}</Flex>
                      <TreatmentSelect value={segment.treatment} availability={autoCensorPolicy.treatments} onChange={(value) => updateApplied(segment.id, (current) => treatmentSettings(current, value))} />
                    </Box>
                    {stale && <Button size="xs" variant="outline" onClick={() => reviewStale(segment)}>Review</Button>}
                    <Button aria-label="Delete censor segment" size="xs" variant="ghost" onClick={() => setCensorSegments(editorDocument.censorSegments.filter((candidate) => candidate.id !== segment.id))}><X size={13} /></Button>
                  </Flex>
                );
              })}
            </Box>
          )}
        </Box>

        <Box px="20px" py="14px" borderTopWidth="1px" borderColor="studio.borderStrong" bg="studio.raised">
          {!autoCensorPolicy.canApply && <Text mb="8px" fontSize="11px" color="studio.fgMuted">Preview is free. Upgrade to Creator to save censor edits.</Text>}
          {autoCensorPolicy.canApply && !hasWritableTreatment && <Text mb="8px" fontSize="11px" color="studio.fgMuted">Scanning is available. Applying censor edits is temporarily unavailable.</Text>}
          <Button w="100%" colorPalette="brand" disabled={!autoCensorPolicy.canApply || !hasWritableTreatment || selectedCount === 0} onClick={apply}>
            Apply {selectedCount > 0 ? selectedCount : "selected"} {selectedCount === 1 ? "edit" : "edits"}
          </Button>
        </Box>
      </Flex>
    </>
  );
}
