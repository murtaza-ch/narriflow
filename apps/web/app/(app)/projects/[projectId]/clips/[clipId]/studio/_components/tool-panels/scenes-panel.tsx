"use client";

import { Box, Button, Flex, Input, NativeSelect, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { chipProps, PanelEmpty, PanelSegmented, SectionLabel, softButtonProps, softFieldProps } from "./panel-ui";
import { Clapperboard, Copy, Image as ImageIcon, MoveLeft, MoveRight, Palette, Play, Trash2, Type, Video } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { PLAN_CATALOG, sourceToEdited, SYSTEM_SCENE_FONT_FAMILIES, type SceneBlock, type SceneContent, type SceneMotion } from "@narriflow/validators";
import { usePlaybackTime } from "../playback-clock";
import { sceneTextContent } from "../scene-fonts";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";

function sceneLabel(content: SceneContent) {
  if (content.kind === "text") return content.text;
  if (content.kind === "color") return "Color card";
  return content.kind === "image" ? "Image scene" : "Video scene";
}

const PLACEMENTS = [
  { value: "start", label: "Start" },
  { value: "playhead", label: "Playhead" },
  { value: "transcript", label: "Next word" },
  { value: "end", label: "End" },
] as const;

const SCENE_KIND_ICONS = { text: Type, color: Palette, image: ImageIcon, video: Video } as const;

// The two add actions under the quick-scene field share one look.
const quickSceneButtonProps = { ...softButtonProps, flex: "1", h: "40px", fontSize: "13px", fontWeight: "500" } as const;
// Small ghost icon buttons on a scene card.
const sceneActionProps = {
  size: "xs",
  variant: "ghost",
  minW: "28px",
  h: "28px",
  px: "0",
  borderRadius: "8px",
  color: "studio.fgMuted",
  _hover: { bg: "studio.raised", color: "studio.fg" },
} as const;
// Fields inside a scene's editor well (which is studio.canvas).
const wellFieldProps = { ...softFieldProps, h: "32px", fontSize: "13px", borderRadius: "8px" } as const;

function WellField({ label, children, minW }: { label: string; children: ReactNode; minW?: string }) {
  return (
    <Stack gap="1" flex="1" minW={minW}>
      <Text as="label" fontSize="12px" color="studio.fgSubtle">{label}</Text>
      {children}
    </Stack>
  );
}

export function ScenesPanel() {
  const studio = useStudio(
    "deleteSceneBlock",
    "duplicateSceneBlock",
    "duration",
    "editedTimeMap",
    "editorDocument",
    "insertSceneBlock",
    "moveSceneBlock",
    "playbackClock",
    "replaceSceneBlock",
    "sceneBlocks",
    "sceneFonts",
    "sceneTemplates",
    "sceneWriteCapabilities",
    "seekTo",
    "trimSceneBlock",
    "updateSceneMotion",
    "upgradePrompts",
    "visualAssets",
  );
  const { openUpgrade } = useUpgrade();
  const canCreateScenes = Object.values(studio.sceneWriteCapabilities).some(Boolean);
  const scenesLock = canCreateScenes ? null : studio.upgradePrompts.scenes;
  const playhead = usePlaybackTime(studio.playbackClock);
  const [placement, setPlacement] = useState<"start" | "playhead" | "transcript" | "end">("playhead");
  const [text, setText] = useState("New chapter");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const totalDuration = studio.duration;
	const insertableFonts = studio.sceneFonts.filter((font) => font.insertable && !font.missing);
  const canWriteScene = (scene: SceneBlock) =>
    (scene.templateSnapshot ? studio.sceneWriteCapabilities.templates : true) &&
    (scene.content.kind === "text" || scene.content.kind === "color"
      ? studio.sceneWriteCapabilities.cards
      : scene.content.kind === "image"
        ? studio.sceneWriteCapabilities.images
        : studio.sceneWriteCapabilities.videos);
  // A locked plan's edit controls open the upgrade instead of doing nothing.
  const lockedEdit = (scene: SceneBlock, edit: () => void) => () => {
    if (canWriteScene(scene)) edit();
    else if (scenesLock?.tier) openUpgrade(scenesLock);
  };
  const transcriptBoundary = useMemo(() => {
    const orderedScenes = [...studio.sceneBlocks].sort((left, right) => left.anchorSec - right.anchorSec);
    const toComposite = (baseSec: number) => {
      let inserted = 0;
      for (const scene of orderedScenes) {
        const baseAnchor = scene.anchorSec - inserted;
        if (baseAnchor > baseSec) break;
        inserted += scene.durationSec;
      }
      return baseSec + inserted;
    };
    const boundaries = studio.editorDocument.transcriptSlice
      .flatMap((utterance) => utterance.words.map((word) => toComposite(sourceToEdited(studio.editedTimeMap, word.startSec))))
      .sort((left, right) => left - right);
    return boundaries.find((boundary) => boundary >= playhead - 0.01) ?? boundaries.at(-1) ?? Math.min(playhead, totalDuration);
  }, [playhead, studio.editorDocument.transcriptSlice, studio.editedTimeMap, studio.sceneBlocks, totalDuration]);
  const anchorSec = placement === "start" ? 0 : placement === "end" ? totalDuration : placement === "transcript" ? transcriptBoundary : Math.min(playhead, totalDuration);

  const insert = (content: SceneContent, durationSec = 3, templateSnapshot: SceneBlock["templateSnapshot"] = null, motion: SceneMotion = { entrance: "fade", exit: "fade", durationSec: 0.5 }) => {
    studio.insertSceneBlock({ id: crypto.randomUUID(), schemaVersion: 1, anchorSec, durationSec, content, motion, templateSnapshot });
  };
  const insertOrReplace = (content: SceneContent, durationSec = 3) => {
		if (selectedSceneId) studio.replaceSceneBlock(selectedSceneId, content, durationSec);
    else insert(content, durationSec);
  };
  const selectField = (label: string, value: string, values: readonly string[], onChange: (value: string) => void) => (
    <WellField label={label} minW="120px">
      <NativeSelect.Root size="xs">
        <NativeSelect.Field {...wellFieldProps} aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
          {values.map((item) => <option key={item} value={item}>{item.replaceAll("-", " ")}</option>)}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </WellField>
  );
  const lock = scenesLock?.tier ? scenesLock : null;
  const insertableAssets = studio.visualAssets.filter((asset) => asset.insertable && (asset.kind === "video" ? studio.sceneWriteCapabilities.videos : studio.sceneWriteCapabilities.images));

  return (
    <Stack gap="5" px="5" pt="4" pb="5">
      {canCreateScenes && <Box>
        <SectionLabel
          action={
            <Text textStyle="data" fontSize="12px" color="studio.timecode" bg="studio.subtle" borderRadius="6px" px="2" py="0.5">
              <VisuallyHidden>Insert time </VisuallyHidden>
              {anchorSec.toFixed(2)}s
            </Text>
          }
        >
          Insert at
        </SectionLabel>
        <PanelSegmented ariaLabel="Insert at" items={PLACEMENTS} value={placement} onChange={setPlacement} />
      </Box>}

      {(lock || studio.sceneWriteCapabilities.cards) && <Box>
        <SectionLabel>Quick scene</SectionLabel>
        <Stack gap="2">
          <Input h="40px" fontSize="14px" placeholder="New chapter" value={text} onChange={(event) => setText(event.target.value.slice(0, 500))} aria-label="Scene text" {...softFieldProps} />
          <Flex gap="2">
            <Button
              {...quickSceneButtonProps}
              aria-label={lock ? "Add text scene (plan upgrade needed)" : selectedSceneId ? "Replace with text scene" : "Add text scene"}
              aria-haspopup={lock ? "dialog" : undefined}
              disabled={!lock && !text.trim()}
              onClick={() => (lock ? openUpgrade(lock) : insertOrReplace(sceneTextContent(text.trim(), studio.sceneFonts)))}
            >
              <Type size={15} />{selectedSceneId && !lock ? "Replace with text" : "Add text"}{lock ? <StudioLockGem tier={lock.tier!} /> : null}
            </Button>
            <Button
              {...quickSceneButtonProps}
              aria-label={lock ? "Add color scene (plan upgrade needed)" : selectedSceneId ? "Replace with color scene" : "Add color scene"}
              aria-haspopup={lock ? "dialog" : undefined}
              onClick={() => (lock ? openUpgrade(lock) : insertOrReplace({ kind: "color", color: "#1D4ED8" }))}
            >
              <Palette size={15} />{selectedSceneId && !lock ? "Replace with color" : "Add color"}{lock ? <StudioLockGem tier={lock.tier!} /> : null}
            </Button>
          </Flex>
        </Stack>
        {lock ? <Text mt="2" fontSize="12px" color="studio.fgSubtle">Scenes need {PLAN_CATALOG[lock.tier!].name}.</Text> : null}
      </Box>}

      {insertableAssets.length > 0 && (
        <Box>
          <SectionLabel>Visual assets</SectionLabel>
          <Stack gap="2">
            {insertableAssets.map((asset) => (
              <Flex key={asset.id} p="2" pr="3" gap="3" align="center" bg="studio.subtle" borderRadius="12px">
                <Flex boxSize="36px" flexShrink={0} align="center" justify="center" bg="studio.raised" borderRadius="8px" color="studio.fgMuted">{asset.kind === "video" ? <Video size={15} /> : <ImageIcon size={15} />}</Flex>
                <Box minW="0" flex="1"><Text fontSize="13px" fontWeight="500" color="studio.fg" truncate>{asset.title}</Text><Text fontSize="12px" color="studio.fgSubtle" textTransform="capitalize">{asset.kind}</Text></Box>
                <Button size="xs" {...softButtonProps} onClick={() => insertOrReplace(asset.kind === "video" ? { kind: "video", asset: { kind: "visual_asset", id: asset.id, fingerprint: asset.fingerprint }, sourceStartSec: 0, sourceEndSec: Math.max(0.1, asset.durationSec ?? 3), fit: "cover", backgroundColor: "#000000", muted: false, volume: 100 } : { kind: "image", asset: { kind: "visual_asset", id: asset.id, fingerprint: asset.fingerprint }, fit: "cover", backgroundColor: "#000000" }, asset.kind === "video" ? Math.min(120, Math.max(0.1, asset.durationSec ?? 3)) : 3)}>{selectedSceneId ? "Replace" : "Insert"}</Button>
              </Flex>
            ))}
          </Stack>
        </Box>
      )}

      {studio.sceneWriteCapabilities.templates && studio.sceneTemplates.length > 0 && (
        <Box>
          <SectionLabel>Brand scenes</SectionLabel>
          <Stack gap="2">
            {studio.sceneTemplates.map((template) => {
              const fontAsset = template.definition.content.kind === "text" ? template.definition.content.fontAsset : null;
              const unavailableFont = fontAsset && !insertableFonts.some((font) => font.id === fontAsset.id && font.fingerprint === fontAsset.fingerprint);
              const visualAsset = template.definition.content.kind === "image" || template.definition.content.kind === "video"
                ? template.definition.content.asset
                : null;
              const unavailableVisual = visualAsset && !studio.visualAssets.some((asset) => asset.insertable && asset.id === visualAsset.id && asset.fingerprint === visualAsset.fingerprint);
              const unavailable = Boolean(unavailableFont || unavailableVisual);
              return <Button key={template.id} {...softButtonProps} h="40px" px="3" justifyContent="space-between" fontSize="13px" fontWeight="500" disabled={unavailable} onClick={() => insert(template.definition.content, template.definition.durationSec, { templateId: template.id, templateRevision: template.revision, fingerprint: template.fingerprint, name: template.name }, template.definition.motion)}>
                <Text truncate>{template.name}</Text><Text textStyle="data" fontSize="12px" color="studio.fgMuted" flexShrink={0}>{unavailable ? (unavailableFont ? "Font missing" : "Asset missing") : `${template.definition.durationSec}s`}</Text>
              </Button>;
            })}
          </Stack>
        </Box>
      )}

      <Box>
        <SectionLabel>Timeline scenes</SectionLabel>
        {studio.sceneBlocks.length === 0 ? (
          <PanelEmpty icon={<Clapperboard size={18} />} title={canCreateScenes || scenesLock ? "No scenes yet" : "Scenes unavailable"}>
            {canCreateScenes ? "Add an opening card, visual insert or reusable brand scene." : scenesLock ? "Scenes add opening cards, visual inserts and reusable brand scenes." : "Scene creation is temporarily unavailable."}
          </PanelEmpty>
        ) : (
          <Stack gap="2">
            {studio.sceneBlocks.map((scene, index) => {
              const content = scene.content;
              const selected = selectedSceneId === scene.id;
              const KindIcon = SCENE_KIND_ICONS[content.kind];
              const sourceDurationSec = content.kind === "video"
                ? studio.visualAssets.find((asset) => asset.id === content.asset.id)?.durationSec ?? content.sourceEndSec
                : null;
              const editLocked = !canWriteScene(scene) && !scenesLock?.tier;
              const lockPopup = canWriteScene(scene) ? undefined : "dialog";
              return (
                <Box key={scene.id} textAlign="left" w="full" bg={selected ? "studio.accentSubtle" : "studio.subtle"} borderRadius="12px" p="3" transition="background 120ms ease">
                  <Button type="button" variant="ghost" h="auto" minH="0" p="0" w="full" justifyContent="flex-start" gap="2.5" _hover={{ bg: "transparent" }} onClick={() => setSelectedSceneId(scene.id)} aria-pressed={selected} aria-label={`Select scene ${index + 1}: ${sceneLabel(content)}`}>
                    <Flex boxSize="28px" flexShrink={0} align="center" justify="center" borderRadius="8px" bg={selected ? "studio.accent" : "studio.raised"} color={selected ? "white" : "studio.fgMuted"}><KindIcon size={14} /></Flex>
                    <Text flex="1" minW="0" textAlign="left" fontSize="13px" fontWeight="500" color={selected ? "studio.accentFg" : "studio.fg"} truncate>{sceneLabel(content)}</Text>
                    <Text textStyle="data" fontSize="12px" color="studio.timecode" flexShrink={0}>{scene.anchorSec.toFixed(1)}s</Text>
                  </Button>
                  <Flex mt="2.5" gap="1" align="center">
                    <Button {...sceneActionProps} disabled={editLocked} aria-haspopup={lockPopup} aria-label="Move scene to start" onClick={lockedEdit(scene, () => studio.moveSceneBlock(scene.id, 0))}><MoveLeft size={14} /></Button>
                    <Button {...sceneActionProps} disabled={editLocked} aria-haspopup={lockPopup} aria-label="Move scene to end" onClick={lockedEdit(scene, () => studio.moveSceneBlock(scene.id, Math.max(0, totalDuration - scene.durationSec)))}><MoveRight size={14} /></Button>
                    <Button {...sceneActionProps} aria-label="Preview scene" onClick={() => studio.seekTo(scene.anchorSec)}><Play size={14} /></Button>
                    <Button {...sceneActionProps} disabled={editLocked} aria-haspopup={lockPopup} aria-label="Duplicate scene" onClick={lockedEdit(scene, () => studio.duplicateSceneBlock(scene.id))}><Copy size={14} /></Button>
                    <Button {...sceneActionProps} color="studio.danger" aria-label="Delete scene" onClick={() => { studio.deleteSceneBlock(scene.id); setSelectedSceneId(null); }}><Trash2 size={14} /></Button>
                    <Flex ml="auto" align="center" gap="1.5">
                      <Input w="60px" px="2" textAlign="right" {...wellFieldProps} bg="studio.canvas" disabled={!canWriteScene(scene)} type="number" min={content.kind === "video" ? 0.1 : 1} max={content.kind === "video" ? content.sourceEndSec - content.sourceStartSec : 30} step="0.1" aria-label={`Duration for scene ${index + 1}`} value={scene.durationSec} onChange={(event) => { const min = content.kind === "video" ? 0.1 : 1; const max = content.kind === "video" ? content.sourceEndSec - content.sourceStartSec : 30; studio.trimSceneBlock(scene.id, Math.min(max, Math.max(min, Number(event.target.value) || min))); }} />
                      <Text fontSize="12px" color="studio.fgSubtle" aria-hidden>s</Text>
                    </Flex>
                  </Flex>
                  {selected && canWriteScene(scene) && (
                    <Stack mt="3" p="3" gap="3" bg="studio.canvas" borderRadius="10px">
                      {content.kind === "text" && <>
                        <WellField label="Copy"><Input aria-label="Scene copy" {...wellFieldProps} value={content.text} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, text: event.currentTarget.value || " " })} /></WellField>
                        <WellField label="Brand font family"><NativeSelect.Root size="xs"><NativeSelect.Field {...wellFieldProps} aria-label="Brand font family" value={content.fontAsset?.id ?? `system:${content.fontFamily}`} onChange={(event) => { const value = event.currentTarget.value; const font = insertableFonts.find((candidate) => candidate.id === value); studio.replaceSceneBlock(scene.id, { ...content, fontFamily: font?.family ?? value.replace(/^system:/, ""), fontAsset: font ? { kind: "brand_font", id: font.id, fingerprint: font.fingerprint } : null }); }}>{SYSTEM_SCENE_FONT_FAMILIES.map((family) => <option key={family} value={`system:${family}`}>{family} · system</option>)}{insertableFonts.map((font) => <option key={font.id} value={font.id}>{font.family} · brand</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></WellField>
                        <Flex gap="3">
                          <WellField label="Text"><Input type="color" aria-label="Scene text color" {...wellFieldProps} p="1" value={content.color} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, color: event.currentTarget.value.toUpperCase() })} /></WellField>
                          <WellField label="Background"><Input type="color" aria-label="Scene background color" {...wellFieldProps} p="1" value={content.backgroundColor} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, backgroundColor: event.currentTarget.value.toUpperCase() })} /></WellField>
                        </Flex>
                      </>}
                      {content.kind === "color" && <WellField label="Card color"><Input type="color" aria-label="Scene card color" {...wellFieldProps} p="1" value={content.color} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, color: event.currentTarget.value.toUpperCase() })} /></WellField>}
                      {(content.kind === "image" || content.kind === "video") && <>
                        <PanelSegmented
                          ariaLabel="Scene fit"
                          size="sm"
                          items={[{ value: "cover", label: "Fill frame" }, { value: "contain", label: "Fit inside" }] as const}
                          value={content.fit}
                          onChange={(fit) => studio.replaceSceneBlock(scene.id, { ...content, fit })}
                        />
                        <WellField label="Letterbox color"><Input type="color" aria-label="Scene letterbox color" {...wellFieldProps} p="1" value={content.backgroundColor} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, backgroundColor: event.currentTarget.value.toUpperCase() })} /></WellField>
                      </>}
                      {content.kind === "video" && <>
                        <Flex gap="3">
                          <WellField label="Source in"><Input type="number" {...wellFieldProps} min="0" max={Math.max(0, Math.min(content.sourceEndSec - 0.1, sourceDurationSec! - 0.1))} step="0.1" aria-label="Video source in" value={content.sourceStartSec} onChange={(event) => { const sourceStartSec = Math.min(content.sourceEndSec - 0.1, sourceDurationSec! - 0.1, Math.max(0, Number(event.currentTarget.value) || 0)); studio.replaceSceneBlock(scene.id, { ...content, sourceStartSec }); }} /></WellField>
                          <WellField label="Source out"><Input type="number" {...wellFieldProps} min={content.sourceStartSec + 0.1} max={sourceDurationSec!} step="0.1" aria-label="Video source out" value={content.sourceEndSec} onChange={(event) => { const sourceEndSec = Math.min(sourceDurationSec!, Math.max(content.sourceStartSec + 0.1, Number(event.currentTarget.value) || content.sourceStartSec + 0.1)); studio.replaceSceneBlock(scene.id, { ...content, sourceEndSec }); }} /></WellField>
                        </Flex>
                        <Flex gap="3" align="end">
                          <Button {...chipProps(content.muted)} variant="ghost" aria-pressed={content.muted} onClick={() => studio.replaceSceneBlock(scene.id, { ...content, muted: !content.muted })}>{content.muted ? "Muted" : "Audio on"}</Button>
                          <WellField label="Volume"><Input type="number" {...wellFieldProps} min="0" max="100" step="1" aria-label="Video scene volume" value={content.volume} disabled={content.muted} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, volume: Math.min(100, Math.max(0, Number(event.currentTarget.value) || 0)) })} /></WellField>
                        </Flex>
                      </>}
                      <Flex gap="3" wrap="wrap">
                        {selectField("Entrance motion", scene.motion.entrance, ["none", "fade", "scale-in", "pan-left", "pan-right", "pan-up", "pan-down", "ken-burns-in"], (entrance) => studio.updateSceneMotion(scene.id, { ...scene.motion, entrance: entrance as SceneMotion["entrance"] }))}
                        {selectField("Exit motion", scene.motion.exit, ["none", "fade", "scale-out", "pan-left", "pan-right", "pan-up", "pan-down", "ken-burns-out"], (exit) => studio.updateSceneMotion(scene.id, { ...scene.motion, exit: exit as SceneMotion["exit"] }))}
                      </Flex>
                    </Stack>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
      {!canCreateScenes && studio.sceneBlocks.length > 0 && (
        <Box bg="studio.subtle" borderRadius="12px" p="4">
          <Text fontSize="13px" color="studio.fgMuted" lineHeight="1.5">
            {scenesLock?.tier
              ? `Editing scenes needs ${PLAN_CATALOG[scenesLock.tier].name}. You can still remove them.`
              : "Scene editing is unavailable. You can still remove scenes."}
          </Text>
          {scenesLock?.tier ? (
            <Button mt="3" size="xs" {...softButtonProps} aria-haspopup="dialog" onClick={() => openUpgrade(scenesLock)}>
              Upgrade to edit scenes<StudioLockGem tier={scenesLock.tier} />
            </Button>
          ) : null}
        </Box>
      )}
    </Stack>
  );
}
