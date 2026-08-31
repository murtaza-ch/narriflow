"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Drawer,
  Flex,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { toaster } from "@narriflow/ui";
import {
  AUTO_CENSOR_DEFAULT_BEEP,
  autoCensorSegmentIsCurrent,
  censorSegmentFromSuggestion,
  scanAutoCensor,
  type AutoCensorScanInput,
  type AutoCensorTreatment,
  type CensorSegment,
} from "@narriflow/validators";
import { formatFractionalDurationRange } from "@/lib/format";
import { useStudio } from "./studio-shell";
import {
  availableAutoCensorTreatments,
  boundedAutoCensorPreview,
} from "./studio-rollout-visibility";

const TREATMENT_LABELS: Readonly<Record<AutoCensorTreatment, string>> = {
  beep: "Beep",
  mute: "Mute dialogue",
  caption_mask: "Mask caption",
};

function TreatmentSelect({
  value,
  onChange,
  disabled = false,
  available,
}: {
  value: AutoCensorTreatment;
  onChange: (value: AutoCensorTreatment) => void;
  disabled?: boolean;
  available: readonly AutoCensorTreatment[];
}) {
  const options = Object.entries(TREATMENT_LABELS).filter(
    ([id]) => id === value || available.includes(id as AutoCensorTreatment),
  );
  return (
    <NativeSelect.Root size="sm" disabled={disabled}>
      <NativeSelect.Field
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as AutoCensorTreatment)}
        bg="studio.subtle"
        borderColor="studio.borderStrong"
      >
        {options.map(([id, label]) => (
          <option key={id} value={id}>{label}</option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

function nextTreatment(
  segment: CensorSegment,
  treatment: AutoCensorTreatment,
): CensorSegment {
  return {
    ...segment,
    treatment,
    beepSettings:
      treatment === "beep"
        ? segment.beepSettings ?? { ...AUTO_CENSOR_DEFAULT_BEEP }
        : null,
    captionMaskPolicy:
      treatment === "caption_mask"
        ? segment.captionMaskPolicy ?? {
            replacement: "asterisks",
            preservePunctuation: true,
          }
        : null,
  };
}

export function AutoCensorReview({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const studio = useStudio();
  const availableTreatments = useMemo(
    () => availableAutoCensorTreatments(studio.autoCensorPolicy.rollout),
    [studio.autoCensorPolicy.rollout],
  );
  const [defaultTreatment, setDefaultTreatment] =
    useState<AutoCensorTreatment>("caption_mask");
  const [projectTerms, setProjectTerms] = useState<string[]>([]);
  const [projectTermDraft, setProjectTermDraft] = useState("");
  const [filter, setFilter] = useState<
    "all" | "selected" | "built_in" | "brand_profile" | "project"
  >("all");
  const [scan, setScan] = useState<ReturnType<typeof scanAutoCensor> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [treatments, setTreatments] = useState<
    Readonly<Record<string, AutoCensorTreatment>>
  >({});

  const scanInput = useMemo<AutoCensorScanInput>(() => ({
    documentRevision: studio.editorRevision,
    locale: studio.autoCensorPolicy.locale,
    clipWindow: {
      startSec: studio.editorDocument.clipStartSec,
      endSec: studio.editorDocument.clipEndSec,
    },
    transcript: studio.editorDocument.transcriptSlice.map((utterance) => ({
      index: utterance.index,
      startSec: utterance.startSec,
      endSec: utterance.endSec,
      words: utterance.words.map((word) => ({
        word: word.word,
        startSec: Number.isFinite(word.startSec) ? word.startSec : null,
        endSec: Number.isFinite(word.endSec) ? word.endSec : null,
        confidence: word.confidence,
      })),
    })),
    defaultTreatment,
    brandTerms: studio.autoCensorPolicy.brandTerms.map((phrase) => ({ phrase })),
    projectTerms: projectTerms.map((phrase) => ({ phrase })),
  }), [
    defaultTreatment,
    projectTerms,
    studio.autoCensorPolicy,
    studio.editorDocument,
    studio.editorRevision,
  ]);

  const runScan = useCallback(() => {
    if (!studio.autoCensorPolicy.rollout.scan) return;
    const result = scanAutoCensor(scanInput);
    setScan(result);
    setSelected(new Set(result.suggestions.map((suggestion) => suggestion.fingerprint)));
    setTreatments(Object.fromEntries(
      result.suggestions.map((suggestion) => [
        suggestion.fingerprint,
        suggestion.proposedTreatment,
      ]),
    ));
  }, [scanInput, studio.autoCensorPolicy.rollout.scan]);

  useEffect(() => {
    if (availableTreatments.includes(defaultTreatment)) return;
    const next = availableTreatments[0];
    if (next) setDefaultTreatment(next);
  }, [availableTreatments, defaultTreatment]);

  useEffect(() => {
    if (open && !scan && studio.autoCensorPolicy.rollout.scan) runScan();
    if (!open) setScan(null);
  }, [open, runScan, scan, studio.autoCensorPolicy.rollout.scan]);

  const currentFingerprints = useMemo(
    () =>
      studio.autoCensorPolicy.rollout.scan
        ? new Set(
            scanAutoCensor(scanInput).suggestions.map(
              (item) => item.fingerprint,
            ),
          )
        : new Set<string>(),
    [scanInput, studio.autoCensorPolicy.rollout.scan],
  );
  const boundedSuggestions = boundedAutoCensorPreview(
    scan?.suggestions ?? [],
    studio.autoCensorPolicy.canPersist,
    studio.autoCensorPolicy.freePreviewLimit,
  );
  const visibleSuggestions = boundedSuggestions.filter((suggestion) =>
    filter === "all"
      ? true
      : filter === "selected"
        ? selected.has(suggestion.fingerprint)
        : suggestion.policySource.kind === filter,
  );
  const selectedCount = boundedSuggestions.filter((suggestion) => {
    const treatment =
      treatments[suggestion.fingerprint] ?? suggestion.proposedTreatment;
    return (
      selected.has(suggestion.fingerprint) &&
      currentFingerprints.has(suggestion.fingerprint) &&
      availableTreatments.includes(treatment) &&
      censorSegmentFromSuggestion(
        suggestion,
        "00000000-0000-4000-8000-000000000000",
        treatment,
      ) !== null
    );
  }).length;

  const addProjectTerm = () => {
    const next = projectTermDraft.trim();
    if (!next || projectTerms.some((term) => term.toLowerCase() === next.toLowerCase())) {
      return;
    }
    setProjectTerms((current) => [...current, next].slice(-50));
    setProjectTermDraft("");
    setScan(null);
  };

  const applySelected = () => {
    if (!studio.autoCensorPolicy.canPersist) return;
    const staleCount = boundedSuggestions.filter(
      (suggestion) =>
        selected.has(suggestion.fingerprint) &&
        !currentFingerprints.has(suggestion.fingerprint),
    ).length;
    const segments = boundedSuggestions.flatMap((suggestion) => {
      if (
        !selected.has(suggestion.fingerprint) ||
        !currentFingerprints.has(suggestion.fingerprint)
      ) {
        return [];
      }
      const segment = censorSegmentFromSuggestion(
        suggestion,
        crypto.randomUUID(),
        treatments[suggestion.fingerprint] ?? suggestion.proposedTreatment,
      );
      return segment && availableTreatments.includes(segment.treatment)
        ? [segment]
        : [];
    });
    if (segments.length === 0) {
      toaster.create({
        type: "info",
        title: staleCount > 0 ? "Scan again before applying" : "Select a timed match",
      });
      return;
    }
    studio.applyCensorSegments(segments);
    toaster.create({
      type: "success",
      title: `${segments.length} censor segment${segments.length === 1 ? "" : "s"} applied`,
      description: staleCount > 0
        ? `${staleCount} stale suggestion${staleCount === 1 ? " was" : "s were"} skipped.`
        : "One undo restores the document to its previous state.",
    });
    onOpenChange(false);
  };

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(details) => onOpenChange(details.open)}
      placement="end"
      size="md"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content bg="studio.surface" borderInlineStartWidth="1px" borderColor="studio.borderStrong">
            <Drawer.Header px="5" py="4" borderBottomWidth="1px" borderColor="studio.border">
              <Flex align="center" justify="space-between" gap="3">
                <Box>
                  <Text textStyle="eyebrow" color="studio.fgMuted">Transcript policy</Text>
                  <Drawer.Title textStyle="title" color="studio.fg">Sensitive-word review</Drawer.Title>
                </Box>
                <IconButton
                  variant="ghost"
                  size="xs"
                  aria-label="Close sensitive-word review"
                  onClick={() => onOpenChange(false)}
                >
                  <X size={15} />
                </IconButton>
              </Flex>
            </Drawer.Header>

            <Drawer.Body px="5" py="4">
              <Stack gap="5">
                {studio.autoCensorPolicy.rollout.scan ? (
                  <>
                <Box layerStyle="well" p="3">
                  <Flex align="end" gap="2">
                    <Box flex="1">
                      <Text textStyle="eyebrow" color="studio.fgMuted" mb="1">Project term</Text>
                      <Input
                        value={projectTermDraft}
                        onChange={(event) => setProjectTermDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addProjectTerm();
                          }
                        }}
                        placeholder="Add a phrase for this review"
                        size="sm"
                        maxLength={80}
                      />
                    </Box>
                    <Button variant="outline" size="sm" onClick={addProjectTerm}>
                      <Plus size={13} /> Add
                    </Button>
                  </Flex>
                  {projectTerms.length > 0 ? (
                    <Flex gap="1" wrap="wrap" mt="2">
                      {projectTerms.map((term) => (
                        <Button
                          key={term}
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setProjectTerms((current) => current.filter((item) => item !== term));
                            setScan(null);
                          }}
                        >
                          {term} <X size={11} />
                        </Button>
                      ))}
                    </Flex>
                  ) : null}
                </Box>

                <Flex gap="2" align="end">
                  <Box flex="1">
                    <Text textStyle="eyebrow" color="studio.fgMuted" mb="1">Default treatment</Text>
                    <TreatmentSelect
                      value={defaultTreatment}
                      available={availableTreatments}
                      disabled={availableTreatments.length === 0}
                      onChange={(value) => {
                        setDefaultTreatment(value);
                        setScan(null);
                      }}
                    />
                  </Box>
                  <Button variant="outline" size="sm" onClick={runScan}>
                    <RotateCcw size={13} /> Scan again
                  </Button>
                </Flex>

                <Flex gap="1" wrap="wrap" role="group" aria-label="Suggestion filters">
                  {(["all", "selected", "built_in", "brand_profile", "project"] as const).map((value) => (
                    <Button
                      key={value}
                      size="xs"
                      variant="outline"
                      borderColor={filter === value ? "studio.accent" : "studio.border"}
                      color={filter === value ? "studio.accentFg" : "studio.fgMuted"}
                      onClick={() => setFilter(value)}
                    >
                      {value.replace("_", " ")}
                    </Button>
                  ))}
                </Flex>

                {visibleSuggestions.length === 0 ? (
                  <Flex direction="column" align="center" gap="2" py="10" color="studio.fgMuted">
                    <Search size={22} />
                    <Text fontSize="13px">No matches in this view.</Text>
                  </Flex>
                ) : (
                  <Stack gap="0" borderTopWidth="1px" borderColor="studio.border">
                    {visibleSuggestions.map((suggestion) => {
                      const isCurrent = currentFingerprints.has(suggestion.fingerprint);
                      const isSelected = selected.has(suggestion.fingerprint);
                      const captionOnly = suggestion.limitation === "caption_only_untimed";
                      return (
                        <Box
                          key={suggestion.fingerprint}
                          py="3"
                          borderBottomWidth="1px"
                          borderColor="studio.border"
                          borderInlineStartWidth="3px"
                          borderInlineStartColor={!isCurrent ? "danger.solid" : isSelected ? "studio.accent" : "studio.borderStrong"}
                          ps="3"
                        >
                          <Flex align="start" gap="3">
                            <Checkbox.Root
                              checked={isSelected}
                              disabled={!isCurrent || suggestion.captionSourceRange === null}
                              onCheckedChange={(details) => {
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (details.checked) next.add(suggestion.fingerprint);
                                  else next.delete(suggestion.fingerprint);
                                  return next;
                                });
                              }}
                            >
                              <Checkbox.HiddenInput />
                              <Checkbox.Control />
                            </Checkbox.Root>
                            <Box flex="1" minW="0">
                              <Text fontSize="13px" color="studio.fg" lineHeight="1.5">
                                <Text as="span" color="studio.fgSubtle">{suggestion.context.before.join(" ")} </Text>
                                <Text as="span" fontWeight="700">{suggestion.context.match.join(" ")}</Text>
                                <Text as="span" color="studio.fgSubtle"> {suggestion.context.after.join(" ")}</Text>
                              </Text>
                              <Flex gap="2" mt="1" wrap="wrap">
                                <Text textStyle="data" fontSize="10px" color="studio.timecode">
                                  {suggestion.wordSourceRange
                                    ? formatFractionalDurationRange(
                                        suggestion.wordSourceRange.startSec,
                                        suggestion.wordSourceRange.endSec,
                                      )
                                    : "No word timing"}
                                </Text>
                                <Text textStyle="eyebrow" fontSize="9px" color="studio.fgMuted">
                                  {suggestion.policySource.kind.replace("_", " ")}
                                </Text>
                                {suggestion.confidence !== null ? (
                                  <Text textStyle="data" fontSize="9px" color="studio.fgMuted">
                                    {Math.round(suggestion.confidence * 100)}% confidence
                                  </Text>
                                ) : null}
                                {captionOnly ? (
                                  <Text fontSize="10px" color="studio.fgMuted">
                                    Caption mask only · word timing unavailable
                                  </Text>
                                ) : null}
                                {!isCurrent ? <Text fontSize="10px" color="danger.fg">Stale—scan again</Text> : null}
                              </Flex>
                              <Box mt="2">
                                <TreatmentSelect
                                  value={treatments[suggestion.fingerprint] ?? suggestion.proposedTreatment}
                                  available={availableTreatments}
                                  disabled={
                                    availableTreatments.length === 0 ||
                                    !isSelected ||
                                    !isCurrent ||
                                    captionOnly
                                  }
                                  onChange={(value) => setTreatments((current) => ({
                                    ...current,
                                    [suggestion.fingerprint]: value,
                                  }))}
                                />
                              </Box>
                            </Box>
                          </Flex>
                        </Box>
                      );
                    })}
                  </Stack>
                )}
                  </>
                ) : (
                  <Box layerStyle="well" p="4">
                    <Text fontSize="12px" color="studio.fgMuted">
                      New scans are paused. Saved censor segments stay active
                      and can still be disabled or removed.
                    </Text>
                  </Box>
                )}

                {studio.editorDocument.censorSegments.length > 0 ? (
                  <Box>
                    <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Applied segments</Text>
                    <Stack gap="2">
                      {studio.editorDocument.censorSegments.map((segment) => (
                        <Flex key={segment.id} align="center" gap="2" wrap="wrap" layerStyle="well" p="2">
                          <Checkbox.Root
                            checked={segment.enabled}
                            disabled={
                              !segment.enabled &&
                              (!studio.autoCensorPolicy.canPersist ||
                                !availableTreatments.includes(segment.treatment))
                            }
                            onCheckedChange={(details) =>
                              studio.setCensorSegmentEnabled(segment.id, Boolean(details.checked))}
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                          </Checkbox.Root>
                          <Text textStyle="data" fontSize="10px" color="studio.timecode" minW="74px">
                            {formatFractionalDurationRange(
                              segment.sourceStartSec,
                              segment.sourceEndSec,
                            )}
                          </Text>
                          {!autoCensorSegmentIsCurrent(segment, scanInput.transcript) ? (
                            <Text fontSize="10px" color="danger.fg">
                              Stale · disable, delete, or scan again before export
                            </Text>
                          ) : null}
                          <TreatmentSelect
                            value={segment.treatment}
                            available={availableTreatments}
                            disabled={
                              !studio.autoCensorPolicy.canPersist ||
                              availableTreatments.length === 0
                            }
                            onChange={(value) =>
                              studio.updateCensorSegment(segment.id, nextTreatment(segment, value))}
                          />
                          <IconButton
                            variant="ghost"
                            size="xs"
                            aria-label="Delete censor segment"
                            onClick={() => studio.deleteCensorSegment(segment.id)}
                          >
                            <Trash2 size={13} />
                          </IconButton>
                        </Flex>
                      ))}
                    </Stack>
                  </Box>
                ) : null}
              </Stack>
            </Drawer.Body>

            <Drawer.Footer px="5" py="4" borderTopWidth="1px" borderColor="studio.border">
              <Flex w="full" align="center" justify="space-between" gap="3">
                <Box>
                  <Text fontSize="12px" color="studio.fg">
                    {studio.autoCensorPolicy.rollout.scan
                      ? `${selectedCount} ready to apply`
                      : `${studio.editorDocument.censorSegments.length} saved segment${studio.editorDocument.censorSegments.length === 1 ? "" : "s"}`}
                  </Text>
                  {studio.autoCensorPolicy.rollout.scan &&
                  !studio.autoCensorPolicy.canPersist ? (
                    <Text fontSize="10px" color="studio.fgMuted">Preview scan only on this plan.</Text>
                  ) : studio.autoCensorPolicy.rollout.scan &&
                    availableTreatments.length === 0 ? (
                    <Text fontSize="10px" color="studio.fgMuted">
                      Treatments are temporarily paused.
                    </Text>
                  ) : null}
                </Box>
                {studio.autoCensorPolicy.rollout.scan ? (
                  <Button
                    variant="outline"
                    borderColor="studio.accent"
                    color="studio.accentFg"
                    disabled={!studio.autoCensorPolicy.canPersist || selectedCount === 0}
                    onClick={applySelected}
                  >
                    Apply selected
                  </Button>
                ) : null}
              </Flex>
            </Drawer.Footer>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
