"use client";

// Text Layer harness (title-text tickets 03 and 04). The sheet draws the shared samples with the real
// Scene painter, tiled like the export's contact sheet; the playground is the Studio's canvas pieces
// (frame, grips, toolbar) and the Text panel's style controls on local state.
import { useCallback, useMemo, useState } from "react";
import { Box, Flex, SimpleGrid, Stack, Text, Textarea } from "@chakra-ui/react";
import { Heading, Type } from "lucide-react";
import { TEXT_LAYER_SAMPLES } from "@narriflow/caption-scene";
import { DEFAULT_BRAND_TITLE, type StudioTextLayer, TEXT_LAYER_STYLE_PRESETS, type TextLayerStyle, studioTextLayerSchema } from "@narriflow/validators";
import { staticTimeSource } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import { CaptionSceneLayers } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-scene-painter";
import { useTextLayerScene } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-scene";
import { TextLayerCanvas, type TextLayerGesturePatch } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-canvas";
import { TextLayerToolbar } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-toolbar";
import { TextStyleSample } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-sample";
import { duplicateTextLayer, newBodyLayer, newTitleLayer, presetStyleFor } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-commands";
import { PanelTabs, SectionLabel, SelectedCheck, softFieldProps, tileProps } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/panel-ui";
import { TextStyleControls } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/text-style-controls";

const WHOLE = { fromMs: 0, toMs: 1_000_000 } as const;
const still = staticTimeSource(0);

/** The export sheet's backgrounds (`BACKGROUNDS` in text-layer-sheet.ts); the photo is the same four colours as a CSS radial gradient. */
const BACKGROUNDS = {
  flat: "#3B6E8F",
  photo: "radial-gradient(circle at 50% 50%, #1C2541 0%, #E9C46A 33%, #F4A261 66%, #2A9D8F 100%)",
} as const;

const SHEETS = {
  vertical: { width: 1080, height: 1920, columns: 7 },
  horizontal: { width: 1920, height: 1080, columns: 5 },
} as const;

/** One sample on its own frame at half size, with the sheet's label in the bottom-left corner. */
function SampleFrame({ index, canvas, background }: { index: number; canvas: { width: number; height: number }; background: keyof typeof BACKGROUNDS }) {
  const sample = TEXT_LAYER_SAMPLES[index]!;
  const entries = useMemo(() => sample.layers.map((layer) => ({ layer, window: WHOLE })), [sample]);
  const built = useTextLayerScene(entries, canvas);
  const scale = 0.5;
  return (
    <div data-sample={sample.id} style={{ position: "relative", width: canvas.width * scale, height: canvas.height * scale, background: BACKGROUNDS[background], overflow: "hidden" }}>
      {built ? <CaptionSceneLayers built={built.built} canvas={canvas} scale={scale} timeSource={still} /> : null}
      <span
        style={{
          position: "absolute",
          left: 24 * scale,
          bottom: 24 * scale,
          fontSize: 40 * scale,
          fontWeight: 800,
          fontFamily: "var(--font-caption-inter-28pt-extrabold), Inter, sans-serif",
          color: "#FFFF00",
          WebkitTextStroke: `${3 * scale * 2}px #000`,
          paintOrder: "stroke fill",
        }}
      >
        {index + 1}. {sample.label}
      </span>
    </div>
  );
}

export function TextLayerSheet({ orientation, background }: { orientation: keyof typeof SHEETS; background: keyof typeof BACKGROUNDS }) {
  const sheet = SHEETS[orientation];
  const canvas = { width: sheet.width, height: sheet.height };
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${sheet.columns}, ${sheet.width / 2}px)`, gap: 8, padding: 0, background: "#111111", width: "max-content" }}>
      <HideDevBadge />
      {TEXT_LAYER_SAMPLES.map((sample, index) => (
        <SampleFrame key={sample.id} index={index} canvas={canvas} background={background} />
      ))}
    </div>
  );
}

/** The dev overlay's badge would cover part of a screenshot. */
const HideDevBadge = () => <style>{"nextjs-portal { display: none; }"}</style>;

// ─── Playground ──────────────────────────────────────────────────────────────

const CANVAS = { width: 1080, height: 1920 } as const;
const PREVIEW_HEIGHT = 760;
const SCALE = PREVIEW_HEIGHT / CANVAS.height;

const INITIAL_LAYERS: StudioTextLayer[] = [
  newTitleLayer({ id: "title", clipTitle: "Why top creators aren't leaving YouTube for Netflix", hookText: null, clipDurationSec: 30, settings: DEFAULT_BRAND_TITLE }),
  studioTextLayerSchema.parse({ id: "body", role: "body", text: "made with Narriflow", positionY: 30, widthPct: 60, style: { fontSize: 36 } }),
];

export function TextLayersPlayground({ initialSelected, initialTab }: { initialSelected: boolean; initialTab: "presets" | "settings" }) {
  const [layers, setLayers] = useState<StudioTextLayer[]>(INITIAL_LAYERS);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected ? "title" : null);
  const [tab, setTab] = useState<"presets" | "settings">(initialSelected ? initialTab : "presets");
  const selected = layers.find((layer) => layer.id === selectedId) ?? null;
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setTab(id ? "settings" : "presets");
  }, []);
  const patch = (id: string, change: Partial<StudioTextLayer>) => setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...change } : layer)));
  const patchStyle = (id: string, change: Partial<TextLayerStyle>) => setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, style: { ...layer.style, ...change } } : layer)));
  const commit = (id: string, change: TextLayerGesturePatch) => {
    const { fontSize, ...place } = change;
    setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...place, ...(fontSize !== undefined ? { style: { ...layer.style, fontSize } } : {}) } : layer)));
  };
  const entries = useMemo(() => layers.map((layer) => ({ layer, window: WHOLE })), [layers]);

  return (
    <Flex minH="100vh" bg="studio.canvas" color="studio.fg" gap="6" p="6" align="flex-start">
      <HideDevBadge />
      <Box
        position="relative"
        flexShrink={0}
        style={{ width: CANVAS.width * SCALE, height: PREVIEW_HEIGHT, background: BACKGROUNDS.photo }}
        borderRadius="4px"
        onClick={() => select(null)}
      >
        <TextLayerCanvas
          entries={entries}
          canvas={CANVAS}
          scale={SCALE}
          timeSource={still}
          timeSec={0}
          selectedId={selectedId}
          onSelect={select}
          onCommit={commit}
          onEditText={(id) => {
            select(id);
            document.getElementById(`playground-text-${id}`)?.focus();
          }}
          toolbar={(layer) => (
            <TextLayerToolbar
              style={layer.style}
              onChange={(change) => patchStyle(layer.id, change)}
              onDuplicate={() => {
                const copy = duplicateTextLayer(layer, crypto.randomUUID());
                setLayers((current) => [...current, copy]);
                select(copy.id);
              }}
              onDelete={() => {
                setLayers((current) => current.filter((candidate) => candidate.id !== layer.id));
                select(null);
              }}
              {...(layer.role === "title" ? { onApplyToAll: () => undefined } : {})}
            />
          )}
        />
      </Box>
      <Box w="360px" flexShrink={0} bg="studio.surface" borderRadius="14px" overflow="hidden">
        <PanelTabs
          ariaLabel="Text"
          items={selected ? [{ id: "presets", label: "Presets" }, { id: "settings", label: "Settings" }] : [{ id: "presets", label: "Presets" }]}
          value={selected ? tab : "presets"}
          onChange={setTab}
        />
        {selected && tab === "settings" ? (
          <Stack gap="4" p="5">
            <Textarea id={`playground-text-${selected.id}`} aria-label="Text" value={selected.text} onChange={(event) => event.target.value.trim() && patch(selected.id, { text: event.target.value })} rows={3} fontSize="14px" {...softFieldProps} />
            <TextStyleControls value={selected.style} onChange={(change) => patchStyle(selected.id, change)} />
          </Stack>
        ) : (
          <Stack gap="5" p="5">
            <Stack gap="2">
              <Flex as="button" h="56px" align="center" justify="center" gap="2.5" borderRadius="12px" bg="studio.subtle" fontSize="17px" fontWeight="600" cursor="pointer" _hover={{ bg: "studio.raised" }} onClick={() => select(layers.find((layer) => layer.role === "title")?.id ?? null)}>
                <Heading size={18} /> {layers.some((layer) => layer.role === "title") ? "Edit the title" : "Add a title"}
              </Flex>
              <Flex
                as="button"
                h="48px"
                align="center"
                justify="center"
                gap="2.5"
                borderRadius="12px"
                bg="studio.subtle"
                fontSize="14px"
                fontWeight="500"
                cursor="pointer"
                _hover={{ bg: "studio.raised" }}
                onClick={() => {
                  const body = newBodyLayer({ id: crypto.randomUUID(), playheadSec: 0, clipDurationSec: 30 });
                  setLayers((current) => [...current, body]);
                  select(body.id);
                }}
              >
                <Type size={16} /> Add body text
              </Flex>
            </Stack>
            <Box>
              <SectionLabel>Recommended</SectionLabel>
              <SimpleGrid columns={2} gap="2">
                {TEXT_LAYER_STYLE_PRESETS.map((preset) => (
                  <Box
                    key={preset.id}
                    as="button"
                    aria-label={`Restyle the title as ${preset.name}`}
                    p="6px"
                    {...tileProps(false)}
                    onClick={() => {
                      const target = selected ?? layers.find((layer) => layer.role === "title");
                      if (target) patch(target.id, { style: presetStyleFor(target, preset.style) });
                    }}
                  >
                    <Box borderRadius="8px" overflow="hidden" bg="#7C828C">
                      <TextStyleSample style={preset.style} />
                    </Box>
                    <Text mt="1.5" px="1" fontSize="12px" fontWeight="500" textAlign="left">
                      {preset.name}
                    </Text>
                    <SelectedCheck show={false} />
                  </Box>
                ))}
              </SimpleGrid>
            </Box>
          </Stack>
        )}
      </Box>
    </Flex>
  );
}
