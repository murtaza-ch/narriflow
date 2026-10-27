"use client";

import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { Box, Button, Flex, Grid, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Plus, Trash2, Type } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@narriflow/ui/components/empty-state";
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

export function SceneTemplateManager({ profileId, scenes, fonts, canManage, canManageDefaults, createRequirement, createUpgrade, defaultsUpgrade }: { profileId: string; scenes: SceneTemplateCard[]; fonts: SceneTemplateFont[]; /** `brand.manage`: without it the scenes are read-only (the page says whom to ask). */ canManage: boolean; canManageDefaults: boolean; /** Why the plan can't create scenes; `null` when it can. Deleting stays available. */ createRequirement: string | null; /** The plan that lifts `createRequirement`; `null` when none does. */ createUpgrade: UpgradePrompt | null; /** The plan that unlocks default intros and outros; `null` when the plan has them or none does. */ defaultsUpgrade: UpgradePrompt | null }) {
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
      <Grid templateColumns={{ base: "1fr", xl: canManage ? "360px 1fr" : "1fr" }} gap="8" alignItems="start">
        {canManage ? (
        <Stack gap="4" bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card" p="5">
          <Box><Text fontSize="16px" fontWeight="500">New frozen scene</Text><Text mt="1" fontSize="13px" color="fg.muted">Create a bounded title card that editors can insert without linking future changes.</Text></Box>
          <Input aria-label="Template name" placeholder="Launch opener" value={name} onChange={(event) => setName(event.target.value.slice(0, 120))} />
          <Input aria-label="Card text" placeholder="Opening title" value={text} onChange={(event) => setText(event.target.value.slice(0, 500))} />
					<Text fontSize="12px" color="fg.subtle">Typography · {activeFont?.family ?? "Archivo system fallback"}</Text>
          <Flex gap="2">
            {(["intro", "inline", "outro"] as const).map((value) => <Button key={value} flex="1" size="sm" variant={role === value ? "subtle" : "ghost"} {...(role === value ? { bg: "accent.subtle", color: "accent.fg", _hover: { bg: "accent.subtle" } } : {})} onClick={() => setRole(value)}>{value}</Button>)}
          </Flex>
          <Flex gap="3" align="center"><Text fontSize="13px" color="fg.muted">Duration</Text><Input type="number" min="1" max="30" step="0.5" value={durationSec} onChange={(event) => setDurationSec(Math.min(30, Math.max(1, Number(event.target.value) || 1)))} /></Flex>
          <Button colorPalette="brand" disabled={!name.trim() || !text.trim() || busy !== null || createRequirement !== null} onClick={create}><Plus size={15} />Save scene</Button>
          <PlanLimitNotice message={createRequirement} upgrade={createUpgrade} />
          {error ? <Text color="danger.fg" fontSize="12px">{error}</Text> : null}
        </Stack>
        ) : null}

        {scenes.length === 0 ? (
          <EmptyState icon={<Type size={20} />} title="No reusable scenes yet" description="Start with an intro, transition card, or closing call to action." />
        ) : (
          <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap="4">
            {scenes.map((scene, index) => (
              <Stack key={scene.id} gap="4" bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card" p="4">
                <Flex align="center" justify="space-between" gap="2"><Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">{String(index + 1).padStart(2, "0")}</Text><Text fontSize="12px" fontWeight="500" color={scene.isDefault ? "accent.fg" : "fg.subtle"}>{scene.isDefault ? `Default ${scene.role}` : scene.role}</Text></Flex>
                <Box minH="120px" borderRadius="l1" display="grid" placeItems="center" px="5" textAlign="center" style={{ background: scene.definition.content.kind === "text" ? scene.definition.content.backgroundColor : scene.definition.content.kind === "color" ? scene.definition.content.color : undefined }}><Text color={scene.definition.content.kind === "text" ? scene.definition.content.color : "fg.muted"} fontFamily={scene.definition.content.kind === "text" ? scene.definition.content.fontFamily : "display"} fontWeight="650">{scene.definition.content.kind === "text" ? scene.definition.content.text : scene.name}</Text></Box>
                <Flex justify="space-between" align="center"><Box><Text fontSize="13px" fontWeight="500">{scene.name}</Text><Text color="fg.subtle" fontSize="12px" fontVariantNumeric="tabular-nums">{scene.definition.durationSec.toFixed(1)}s · r{scene.revision}</Text></Box>{canManage ? <Flex gap="1">{!canManageDefaults && defaultsUpgrade && scene.role !== "inline" && !scene.isDefault ? <LockedButton size="sm" variant="ghost" aria-label={`Make ${scene.name} default`} prompt={defaultsUpgrade}><Check size={13} /></LockedButton> : null}{canManageDefaults && scene.role !== "inline" && !scene.isDefault ? <Button size="sm" variant="ghost" aria-label={`Make ${scene.name} default`} disabled={busy !== null} onClick={() => request(scene.id, `/api/brand-profiles/${profileId}/scene-templates/${scene.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: scene.revision, makeDefault: true }) })}><Check size={13} /></Button> : null}<Button size="sm" variant="ghost" color="danger.fg" aria-label={`Delete ${scene.name}`} disabled={busy !== null} onClick={() => request(scene.id, `/api/brand-profiles/${profileId}/scene-templates/${scene.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: scene.revision }) })}><Trash2 size={13} /></Button></Flex> : null}</Flex>
              </Stack>
            ))}
          </Grid>
        )}
      </Grid>
    </Stack>
  );
}
