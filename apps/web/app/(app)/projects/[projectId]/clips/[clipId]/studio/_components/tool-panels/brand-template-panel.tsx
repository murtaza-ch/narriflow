"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, LayoutGrid } from "lucide-react";
import { Spinner } from "@narriflow/ui";
import type { BrandTemplateSummary } from "@narriflow/validators";
import { useStudio } from "../studio-shell";

interface BrandTemplateResponse {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  defaultId: string | null;
}

function TemplateRow({
  template,
  selected,
  onSelect,
}: {
  template: BrandTemplateSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={selected}
      align="center"
      gap="10px"
      w="100%"
      p="10px"
      borderRadius="l2"
      border="1px solid"
      borderColor={selected ? "studio.accent" : "studio.border"}
      bg={selected ? "studio.raised" : "studio.subtle"}
      cursor="pointer"
      textAlign="left"
      transition="background 120ms ease, border-color 120ms ease"
      _hover={{ borderColor: selected ? "studio.accent" : "studio.borderStrong" }}
      onClick={onSelect}
    >
      {/* User brand colors — literal by design */}
      <Flex flexShrink={0} gap="3px">
        <Box w="14px" h="28px" borderRadius="4px 0 0 4px" bg={template.primaryColor} />
        <Box w="14px" h="28px" borderRadius="0 4px 4px 0" bg={template.secondaryColor} />
      </Flex>
      <Box minW="0" flex="1">
        <Text fontSize="12px" fontWeight="600" color="studio.fg" truncate>
          {template.name}
        </Text>
        <Text fontSize="11px" color="studio.fgMuted" mt="1px">
          {template.captionPreset.fontName} · {template.captionPreset.position}
        </Text>
      </Box>
      {selected ? (
        <Box color="studio.accentFg" flexShrink={0}>
          <Check size={14} />
        </Box>
      ) : null}
    </Flex>
  );
}

export function BrandTemplatePanel() {
  const { setCaptionPreset } = useStudio();
  const [templates, setTemplates] = useState<BrandTemplateResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [applyState, setApplyState] = useState<
    "idle" | "applied" | "missing"
  >("idle");

  useEffect(() => {
    let canceled = false;
    async function loadTemplates() {
      setLoadState("loading");
      try {
        const response = await fetch("/api/brand-templates");
        if (!response.ok) throw new Error("failed");
        const payload = (await response.json()) as BrandTemplateResponse;
        if (canceled) return;
        setTemplates(payload);
        setSelectedId(payload.defaultId ?? payload.mine[0]?.id ?? payload.builtIns[0]?.id ?? null);
        setLoadState("ready");
      } catch {
        if (!canceled) setLoadState("error");
      }
    }
    void loadTemplates();
    return () => {
      canceled = true;
    };
  }, []);

  const allTemplates = useMemo(
    () => [...(templates?.mine ?? []), ...(templates?.builtIns ?? [])],
    [templates],
  );
  const selectedTemplate = allTemplates.find((template) => template.id === selectedId);

  function applyTemplate() {
    if (!selectedTemplate) {
      setApplyState("missing");
      setTimeout(() => setApplyState("idle"), 2500);
      return;
    }

    setCaptionPreset((current) => ({
      ...current,
      ...selectedTemplate.captionPreset,
      positionX: current.positionX,
      positionY: current.positionY,
      fontSize: current.fontSize,
    }));
    setApplyState("applied");
    setTimeout(() => setApplyState("idle"), 2000);
  }

  if (loadState === "loading") {
    return (
      <Flex align="center" justify="center" h="160px" color="studio.fgMuted" gap="8px">
        <Spinner size="xs" />
        <Text fontSize="12px" color="studio.fgMuted">Loading templates</Text>
      </Flex>
    );
  }

  if (loadState === "error") {
    return (
      <Flex role="alert" align="center" gap="8px" p="12px" color="danger.400">
        <AlertTriangle size={14} />
        <Text fontSize="12px" color="danger.400">
          Brand templates could not be loaded.
        </Text>
      </Flex>
    );
  }

  return (
    <Stack gap="14px" p="12px">
      {templates?.mine.length ? (
        <Stack gap="8px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            My templates
          </Text>
          {templates.mine.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              selected={template.id === selectedId}
              onSelect={() => setSelectedId(template.id)}
            />
          ))}
        </Stack>
      ) : null}

      {templates?.builtIns.length ? (
        <Stack gap="8px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Built-in
          </Text>
          {templates.builtIns.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              selected={template.id === selectedId}
              onSelect={() => setSelectedId(template.id)}
            />
          ))}
        </Stack>
      ) : null}

      {/* Secondary action — Export owns the view's solid button */}
      <Flex
        as="button"
        align="center"
        justify="center"
        h="34px"
        borderRadius="l2"
        bg="studio.raised"
        borderWidth="1px"
        borderColor={applyState === "missing" ? "danger.solid" : "studio.borderStrong"}
        color={applyState === "missing" ? "danger.400" : "studio.fg"}
        fontSize="12px"
        fontWeight="600"
        cursor="pointer"
        gap="6px"
        _hover={{ borderColor: applyState === "missing" ? "danger.solid" : "studio.fgSubtle" }}
        transition="border-color 120ms ease, color 120ms ease"
        onClick={applyTemplate}
      >
        {applyState === "applied" ? (
          <Check size={14} />
        ) : applyState === "missing" ? (
          <AlertTriangle size={14} />
        ) : (
          <LayoutGrid size={14} />
        )}
        {applyState === "applied"
          ? "Template applied"
          : applyState === "missing"
            ? "Choose a template"
            : "Apply to captions"}
      </Flex>
    </Stack>
  );
}
