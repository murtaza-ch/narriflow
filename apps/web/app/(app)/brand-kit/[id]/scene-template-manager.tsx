"use client";

import { Box, Button, Flex, Grid, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SceneTemplateDefinition, SceneTemplateRole } from "@narriflow/validators";

export interface SceneTemplateCard {
  id: string;
  name: string;
  role: SceneTemplateRole;
  revision: number;
  fingerprint: string;
  definition: SceneTemplateDefinition;
  isDefault: boolean;
}

export interface SceneTemplateFont {
	id: string;
	family: string;
	fingerprint: string;
	missing: boolean;
}

export function SceneTemplateManager({ profileId, scenes, fonts, canManageDefaults }: { profileId: string; scenes: SceneTemplateCard[]; fonts: SceneTemplateFont[]; canManageDefaults: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [text, setText] = useState("Opening title");
  const [durationSec, setDurationSec] = useState(3);
  const [role, setRole] = useState<SceneTemplateRole>("inline");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
	const activeFont = fonts.find((font) => !font.missing) ?? null;

  const request = async (key: string, url: string, init: RequestInit) => {
    setBusy(key); setError(null);
    try {
      const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || "Scene template could not be saved");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Scene template could not be saved");
    } finally { setBusy(null); }
  };

  const create = () => request("create", `/api/brand-profiles/${profileId}/scene-templates`, {
    method: "POST",
    body: JSON.stringify({
      name: name.trim(), role, makeDefault: canManageDefaults && role !== "inline",
      definition: { schemaVersion: 1, durationSec, content: { kind: "text", text: text.trim(), fontFamily: activeFont?.family ?? "Archivo", fontAsset: activeFont ? { kind: "brand_font", id: activeFont.id, fingerprint: activeFont.fingerprint } : null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } },
    }),
  });

  return (
    <Stack gap="7">
      <Grid templateColumns={{ base: "1fr", xl: "360px 1fr" }} gap="8" alignItems="start">
        <Stack gap="4" borderTopWidth="3px" borderColor="accent.solid" pt="5">
          <Box><Text textStyle="eyebrow" color="accent.fg">New frozen scene</Text><Text mt="1" fontSize="13px" color="fg.muted">Create a bounded title card that editors can insert without linking future changes.</Text></Box>
          <Input aria-label="Template name" placeholder="Launch opener" value={name} onChange={(event) => setName(event.target.value.slice(0, 120))} />
          <Input aria-label="Card text" placeholder="Opening title" value={text} onChange={(event) => setText(event.target.value.slice(0, 500))} />
					<Text textStyle="eyebrow" color="fg.subtle">Typography · {activeFont?.family ?? "Archivo system fallback"}</Text>
          <Flex gap="2">
            {(["intro", "inline", "outro"] as const).map((value) => <Button key={value} flex="1" size="sm" variant="outline" colorPalette={role === value ? "accent" : undefined} onClick={() => setRole(value)}>{value}</Button>)}
          </Flex>
          <Flex gap="3" align="center"><Text textStyle="eyebrow" color="fg.subtle">Duration</Text><Input type="number" min="1" max="30" step="0.5" value={durationSec} onChange={(event) => setDurationSec(Math.min(30, Math.max(1, Number(event.target.value) || 1)))} /></Flex>
          <Button colorPalette="brand" disabled={!name.trim() || !text.trim() || busy !== null} onClick={create}><Plus size={15} />Save scene</Button>
          {error ? <Text color="danger.fg" fontSize="12px">{error}</Text> : null}
        </Stack>

        {scenes.length === 0 ? (
          <Box bg="bg.panel" borderRadius="l2" p="8"><Text textStyle="title" fontSize="20px">No reusable scenes yet</Text><Text mt="2" fontSize="13px" color="fg.muted">Start with an intro, transition card, or closing call to action.</Text></Box>
        ) : (
          <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap="4">
            {scenes.map((scene, index) => (
              <Stack key={scene.id} gap="4" bg="bg.panel" borderRadius="l2" p="4">
                <Flex align="center" gap="2"><Text textStyle="data" color="fg.subtle">{String(index + 1).padStart(2, "0")}</Text><Box h="1px" bg="border" flex="1" /><Text textStyle="eyebrow" color={scene.isDefault ? "accent.fg" : "fg.subtle"}>{scene.isDefault ? `Default ${scene.role}` : scene.role}</Text></Flex>
                <Box minH="120px" borderRadius="l1" display="grid" placeItems="center" px="5" textAlign="center" style={{ background: scene.definition.content.kind === "text" ? scene.definition.content.backgroundColor : scene.definition.content.kind === "color" ? scene.definition.content.color : undefined }}><Text color={scene.definition.content.kind === "text" ? scene.definition.content.color : "fg.muted"} fontFamily={scene.definition.content.kind === "text" ? scene.definition.content.fontFamily : "display"} fontWeight="650">{scene.definition.content.kind === "text" ? scene.definition.content.text : scene.name}</Text></Box>
                <Flex justify="space-between" align="center"><Box><Text fontSize="13px" fontWeight="650">{scene.name}</Text><Text textStyle="data" color="fg.timecode" fontSize="10px">{scene.definition.durationSec.toFixed(1)}s · r{scene.revision}</Text></Box><Flex gap="1">{canManageDefaults && scene.role !== "inline" && !scene.isDefault ? <Button size="sm" variant="ghost" aria-label={`Make ${scene.name} default`} disabled={busy !== null} onClick={() => request(scene.id, `/api/brand-profiles/${profileId}/scene-templates/${scene.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: scene.revision, makeDefault: true }) })}><Check size={13} /></Button> : null}<Button size="sm" variant="ghost" color="danger.fg" aria-label={`Delete ${scene.name}`} disabled={busy !== null} onClick={() => request(scene.id, `/api/brand-profiles/${profileId}/scene-templates/${scene.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: scene.revision }) })}><Trash2 size={13} /></Button></Flex></Flex>
              </Stack>
            ))}
          </Grid>
        )}
      </Grid>
    </Stack>
  );
}
