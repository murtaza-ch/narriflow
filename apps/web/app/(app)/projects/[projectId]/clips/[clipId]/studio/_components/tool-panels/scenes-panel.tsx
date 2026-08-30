"use client";

import { Box, Button, Flex, Input, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { Copy, Image as ImageIcon, MoveLeft, MoveRight, Play, Trash2, Type, Video } from "lucide-react";
import { useMemo, useState } from "react";
import { sourceToEdited, SYSTEM_SCENE_FONT_FAMILIES, type SceneBlock, type SceneContent, type SceneMotion } from "@narriflow/validators";
import { usePlaybackTime } from "../playback-clock";
import { sceneTextContent } from "../scene-fonts";
import { useStudio } from "../studio-shell";

function sceneLabel(content: SceneContent) {
  if (content.kind === "text") return content.text;
  if (content.kind === "color") return "Color card";
  return content.kind === "image" ? "Image scene" : "Video scene";
}

export function ScenesPanel() {
  const studio = useStudio();
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

  const insert = (content: SceneContent, durationSec = 3, templateSnapshot: SceneBlock["templateSnapshot"] = null, motion: SceneMotion = { entrance: "fade", exit: "fade" }) => {
    studio.insertSceneBlock({ id: crypto.randomUUID(), schemaVersion: 1, anchorSec, durationSec, content, motion, templateSnapshot });
  };
  const insertOrReplace = (content: SceneContent, durationSec = 3) => {
		if (selectedSceneId) studio.replaceSceneBlock(selectedSceneId, content, durationSec);
    else insert(content, durationSec);
  };
	const selectField = (label: string, value: string, values: readonly string[], onChange: (value: string) => void) => (
		<Stack gap="1" flex="1" minW="120px">
			<Text as="label" textStyle="eyebrow" color="studio.fgSubtle">{label}</Text>
			<NativeSelect.Root size="xs">
				<NativeSelect.Field aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
					{values.map((item) => <option key={item} value={item}>{item.replaceAll("-", " ")}</option>)}
				</NativeSelect.Field>
				<NativeSelect.Indicator />
			</NativeSelect.Root>
		</Stack>
	);

  return (
    <Stack gap="5" px="4" py="4">
      {Object.values(studio.sceneWriteCapabilities).some(Boolean) && <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Insert at</Text>
        <Flex borderWidth="1px" borderColor="studio.border" borderRadius="l1" overflow="hidden">
          {(["start", "playhead", "transcript", "end"] as const).map((value) => (
            <Button key={value} flex="1" size="xs" borderRadius="0" variant="ghost" bg={placement === value ? "studio.raised" : "transparent"} color={placement === value ? "studio.accentFg" : "studio.fgMuted"} onClick={() => setPlacement(value)}>
              {value === "playhead" ? "Playhead" : value === "transcript" ? "Next word" : value[0]!.toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </Flex>
        <Text mt="2" fontSize="11px" color="studio.timecode" textStyle="data">{anchorSec.toFixed(2)}s</Text>
      </Box>}

      {studio.sceneWriteCapabilities.cards && <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Quick scene</Text>
        <Flex gap="2">
          <Input size="sm" value={text} onChange={(event) => setText(event.target.value.slice(0, 500))} aria-label="Scene text" borderColor="studio.border" />
          <Button size="sm" variant="outline" aria-label={selectedSceneId ? "Replace selected scene with text" : "Insert text scene"} disabled={!text.trim()} onClick={() => insertOrReplace(sceneTextContent(text.trim(), studio.sceneFonts))}><Type size={15} /></Button>
          <Button size="sm" variant="outline" aria-label={selectedSceneId ? "Replace selected scene with color" : "Insert color scene"} onClick={() => insertOrReplace({ kind: "color", color: "#1D4ED8" })}>Color</Button>
        </Flex>
      </Box>}

      {studio.visualAssets.some((asset) => asset.insertable && (asset.kind === "video" ? studio.sceneWriteCapabilities.videos : studio.sceneWriteCapabilities.images)) && (
        <Box>
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Visual assets</Text>
          <Stack gap="0" borderTopWidth="1px" borderColor="studio.border">
            {studio.visualAssets.filter((asset) => asset.insertable && (asset.kind === "video" ? studio.sceneWriteCapabilities.videos : studio.sceneWriteCapabilities.images)).map((asset) => (
              <Flex key={asset.id} py="3" gap="3" align="center" borderBottomWidth="1px" borderColor="studio.border">
                <Flex w="28px" h="28px" align="center" justify="center" bg="studio.raised" color="studio.fgMuted">{asset.kind === "video" ? <Video size={14} /> : <ImageIcon size={14} />}</Flex>
                <Box minW="0" flex="1"><Text fontSize="12px" color="studio.fg" truncate>{asset.title}</Text><Text fontSize="10px" color="studio.fgSubtle">{asset.kind}</Text></Box>
                <Button size="xs" variant="outline" onClick={() => insertOrReplace(asset.kind === "video" ? { kind: "video", asset: { kind: "visual_asset", id: asset.id, fingerprint: asset.fingerprint }, sourceStartSec: 0, sourceEndSec: Math.max(0.1, asset.durationSec ?? 3), fit: "cover", backgroundColor: "#000000", muted: false, volume: 100 } : { kind: "image", asset: { kind: "visual_asset", id: asset.id, fingerprint: asset.fingerprint }, fit: "cover", backgroundColor: "#000000" }, asset.kind === "video" ? Math.min(120, Math.max(0.1, asset.durationSec ?? 3)) : 3)}>{selectedSceneId ? "Replace" : "Insert"}</Button>
              </Flex>
            ))}
          </Stack>
        </Box>
      )}

      {studio.sceneWriteCapabilities.templates && studio.sceneTemplates.length > 0 && (
        <Box>
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Brand scenes</Text>
          <Stack gap="2">
            {studio.sceneTemplates.map((template) => {
							const fontAsset = template.definition.content.kind === "text" ? template.definition.content.fontAsset : null;
							const unavailableFont = fontAsset && !insertableFonts.some((font) => font.id === fontAsset.id && font.fingerprint === fontAsset.fingerprint);
							const visualAsset = template.definition.content.kind === "image" || template.definition.content.kind === "video"
								? template.definition.content.asset
								: null;
							const unavailableVisual = visualAsset && !studio.visualAssets.some((asset) => asset.insertable && asset.id === visualAsset.id && asset.fingerprint === visualAsset.fingerprint);
							const unavailable = Boolean(unavailableFont || unavailableVisual);
							return <Button key={template.id} variant="outline" size="sm" justifyContent="space-between" disabled={unavailable} title={unavailable ? "Restore or replace the missing Scene asset before inserting this template" : undefined} onClick={() => insert(template.definition.content, template.definition.durationSec, { templateId: template.id, templateRevision: template.revision, fingerprint: template.fingerprint, name: template.name }, template.definition.motion)}>
								<Text truncate>{template.name}</Text><Text textStyle="data" fontSize="10px">{template.definition.durationSec}s</Text>
							</Button>;
						})}
          </Stack>
        </Box>
      )}

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="2">Timeline scenes</Text>
        {studio.sceneBlocks.length === 0 ? (
          <Box layerStyle="well" p="4"><Text fontSize="12px" color="studio.fgMuted">Add an opening card, visual insert, or reusable brand scene.</Text></Box>
        ) : (
          <Stack gap="2">
						{studio.sceneBlocks.map((scene, index) => {
							const content = scene.content;
							const sourceDurationSec = content.kind === "video"
								? studio.visualAssets.find((asset) => asset.id === content.asset.id)?.durationSec ?? content.sourceEndSec
								: null;
							return (
              <Box key={scene.id} textAlign="left" w="full" borderWidth="1px" borderColor={selectedSceneId === scene.id ? "studio.accent" : "studio.border"} borderLeftWidth="3px" borderLeftColor="studio.accent" p="3">
				<Button type="button" variant="ghost" h="auto" minH="0" p="0" w="full" justifyContent="space-between" onClick={() => setSelectedSceneId(scene.id)} aria-pressed={selectedSceneId === scene.id} aria-label={`Select scene ${index + 1}: ${sceneLabel(content)}`}>
					<Text fontSize="12px" fontWeight="600" color="studio.fg" truncate>{sceneLabel(content)}</Text><Text textStyle="data" fontSize="10px" color="studio.timecode">{scene.anchorSec.toFixed(1)}s</Text>
                </Button>
                <Flex mt="3" gap="1" wrap="wrap">
                  <Button size="xs" variant="ghost" disabled={!canWriteScene(scene)} aria-label="Move scene to start" onClick={() => studio.moveSceneBlock(scene.id, 0)}><MoveLeft size={13} /></Button>
                  <Button size="xs" variant="ghost" disabled={!canWriteScene(scene)} aria-label="Move scene to end" onClick={() => studio.moveSceneBlock(scene.id, Math.max(0, totalDuration - scene.durationSec))}><MoveRight size={13} /></Button>
                  <Button size="xs" variant="ghost" aria-label="Preview scene" onClick={() => studio.seekTo(scene.anchorSec)}><Play size={13} /></Button>
                  <Button size="xs" variant="ghost" disabled={!canWriteScene(scene)} aria-label="Duplicate scene" onClick={() => studio.duplicateSceneBlock(scene.id)}><Copy size={13} /></Button>
                  <Button size="xs" variant="ghost" disabled={!canWriteScene(scene)} color="danger.fg" aria-label="Delete scene" onClick={() => { studio.deleteSceneBlock(scene.id); setSelectedSceneId(null); }}><Trash2 size={13} /></Button>
					<Input ml="auto" w="64px" h="24px" px="2" disabled={!canWriteScene(scene)} type="number" min={content.kind === "video" ? 0.1 : 1} max={content.kind === "video" ? content.sourceEndSec - content.sourceStartSec : 30} step="0.1" aria-label={`Duration for scene ${index + 1}`} value={scene.durationSec} onChange={(event) => { const min = content.kind === "video" ? 0.1 : 1; const max = content.kind === "video" ? content.sourceEndSec - content.sourceStartSec : 30; studio.trimSceneBlock(scene.id, Math.min(max, Math.max(min, Number(event.target.value) || min))); }} />
                </Flex>
						{selectedSceneId === scene.id && canWriteScene(scene) && (
							<Stack mt="3" pt="3" gap="3" borderTopWidth="1px" borderColor="studio.border">
								{content.kind === "text" && <>
									<Stack gap="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Copy</Text><Input size="xs" aria-label="Scene copy" value={content.text} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, text: event.currentTarget.value || " " })} /></Stack>
									<Stack gap="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Brand font family</Text><NativeSelect.Root size="xs"><NativeSelect.Field aria-label="Brand font family" value={content.fontAsset?.id ?? `system:${content.fontFamily}`} onChange={(event) => { const value = event.currentTarget.value; const font = insertableFonts.find((candidate) => candidate.id === value); studio.replaceSceneBlock(scene.id, { ...content, fontFamily: font?.family ?? value.replace(/^system:/, ""), fontAsset: font ? { kind: "brand_font", id: font.id, fingerprint: font.fingerprint } : null }); }}>{SYSTEM_SCENE_FONT_FAMILIES.map((family) => <option key={family} value={`system:${family}`}>{family} · system</option>)}{insertableFonts.map((font) => <option key={font.id} value={font.id}>{font.family} · brand</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Stack>
									<Flex gap="3">
										<Stack gap="1" flex="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Text</Text><Input type="color" p="1" h="32px" aria-label="Scene text color" value={content.color} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, color: event.currentTarget.value.toUpperCase() })} /></Stack>
										<Stack gap="1" flex="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Background</Text><Input type="color" p="1" h="32px" aria-label="Scene background color" value={content.backgroundColor} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, backgroundColor: event.currentTarget.value.toUpperCase() })} /></Stack>
									</Flex>
								</>}
								{content.kind === "color" && <Stack gap="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Card color</Text><Input type="color" p="1" h="32px" aria-label="Scene card color" value={content.color} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, color: event.currentTarget.value.toUpperCase() })} /></Stack>}
								{(content.kind === "image" || content.kind === "video") && <>
									<Flex gap="2">
										{(["cover", "contain"] as const).map((fit) => <Button key={fit} flex="1" size="xs" variant="outline" bg={content.fit === fit ? "studio.raised" : "transparent"} onClick={() => studio.replaceSceneBlock(scene.id, { ...content, fit })}>{fit === "cover" ? "Fill frame" : "Fit inside"}</Button>)}
									</Flex>
									<Stack gap="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Letterbox color</Text><Input type="color" p="1" h="32px" aria-label="Scene letterbox color" value={content.backgroundColor} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, backgroundColor: event.currentTarget.value.toUpperCase() })} /></Stack>
								</>}
								{content.kind === "video" && <>
									<Flex gap="2">
										<Stack gap="1" flex="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Source in</Text><Input size="xs" type="number" min="0" max={Math.max(0, Math.min(content.sourceEndSec - 0.1, sourceDurationSec! - 0.1))} step="0.1" aria-label="Video source in" value={content.sourceStartSec} onChange={(event) => { const sourceStartSec = Math.min(content.sourceEndSec - 0.1, sourceDurationSec! - 0.1, Math.max(0, Number(event.currentTarget.value) || 0)); studio.replaceSceneBlock(scene.id, { ...content, sourceStartSec }); }} /></Stack>
										<Stack gap="1" flex="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Source out</Text><Input size="xs" type="number" min={content.sourceStartSec + 0.1} max={sourceDurationSec!} step="0.1" aria-label="Video source out" value={content.sourceEndSec} onChange={(event) => { const sourceEndSec = Math.min(sourceDurationSec!, Math.max(content.sourceStartSec + 0.1, Number(event.currentTarget.value) || content.sourceStartSec + 0.1)); studio.replaceSceneBlock(scene.id, { ...content, sourceEndSec }); }} /></Stack>
									</Flex>
									<Flex gap="2" align="end">
										<Button size="xs" variant="outline" aria-pressed={content.muted} onClick={() => studio.replaceSceneBlock(scene.id, { ...content, muted: !content.muted })}>{content.muted ? "Muted" : "Audio on"}</Button>
										<Stack gap="1" flex="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Volume</Text><Input size="xs" type="number" min="0" max="100" step="1" aria-label="Video scene volume" value={content.volume} disabled={content.muted} onChange={(event) => studio.replaceSceneBlock(scene.id, { ...content, volume: Math.min(100, Math.max(0, Number(event.currentTarget.value) || 0)) })} /></Stack>
									</Flex>
								</>}
								<Flex gap="2" wrap="wrap">
									{selectField("Entrance motion", scene.motion.entrance, ["none", "fade", "slide-up", "zoom-in"], (entrance) => studio.updateSceneMotion(scene.id, { ...scene.motion, entrance: entrance as SceneMotion["entrance"] }))}
									{selectField("Exit motion", scene.motion.exit, ["none", "fade", "slide-down", "zoom-out"], (exit) => studio.updateSceneMotion(scene.id, { ...scene.motion, exit: exit as SceneMotion["exit"] }))}
								</Flex>
							</Stack>
						)}
              </Box>
							);
						})}
          </Stack>
        )}
      </Box>
      {!Object.values(studio.sceneWriteCapabilities).some(Boolean) && studio.sceneBlocks.length > 0 && (
        <Box layerStyle="well" p="3"><Text fontSize="12px" color="studio.fgMuted">Scene editing is read-only. Existing scenes remain in preview and exports.</Text></Box>
      )}
    </Stack>
  );
}
