"use client";

import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { Box, Flex, Grid, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { Check, Gem, MoreVertical, Plus, Star, Trash2, Type } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Dialog } from "@narriflow/ui/components/dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Slider } from "@narriflow/ui/components/slider";
import { toaster } from "@narriflow/ui/components/toaster";
import type { SceneTemplateDefinition, SceneTemplateRole } from "@narriflow/validators";
import { failureMessage, useBrandApi, useIntent } from "../_components/brand-api";
import { CoverChip, SWATCH_RING, TabToolbar, plural, type BrandColors } from "../_components/brand-kit-ui";
import { STYLE_GRID_COLUMNS } from "../_components/template-gallery";

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

interface SceneJob {
  /** What is busy while it runs: a scene id, or `create`. */
  key: string;
  success: string;
  run: () => Promise<unknown>;
}

const ROLE_LABEL: Record<SceneTemplateRole, string> = { intro: "Intro", inline: "Inline", outro: "Outro" };
const ROLE_OPTIONS = (["intro", "inline", "outro"] as const).map((value) => ({ label: ROLE_LABEL[value], value }));

/** A title card as the clip shows it: text centered on its background. */
function ScenePreview({ text, color, backgroundColor, fontFamily, large = false }: { text: string; color: string; backgroundColor: string; fontFamily: string; large?: boolean }) {
  return (
    <Flex aspectRatio={9 / 16} align="center" justify="center" px={large ? "6" : "4"} textAlign="center" borderRadius="l2" transition="background 160ms ease" style={{ background: backgroundColor }}>
      <Text fontWeight="700" letterSpacing="-0.02em" lineHeight="1.15" lineClamp={5} wordBreak="break-word" fontSize={large ? "26px" : "17px"} style={{ color, fontFamily }}>
        {text}
      </Text>
    </Flex>
  );
}

export function SceneTemplateManager({ profileId, scenes, fonts, colors, canManage, canManageDefaults, createRequirement, createUpgrade, defaultsRequirement, defaultsUpgrade }: { profileId: string; scenes: SceneTemplateCard[]; fonts: SceneTemplateFont[]; /** The profile's palette, offered for scene text and backgrounds. */ colors: BrandColors; /** `brand.manage`: without it the scenes are read-only (the page says whom to ask). */ canManage: boolean; canManageDefaults: boolean; /** Why the plan can't create scenes; `null` when it can. Deleting stays available. */ createRequirement: string | null; /** The plan that lifts `createRequirement`; `null` when none does. */ createUpgrade: UpgradePrompt | null; /** Why the plan can't set default intros and outros; `null` when it can. */ defaultsRequirement: string | null; /** The plan that unlocks default intros and outros; `null` when the plan has them or none does. */ defaultsUpgrade: UpgradePrompt | null }) {
  const { mutations, invalidate } = useBrandApi();
  const createIntent = useIntent<unknown>();
  const [composing, setComposing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const activeFont = fonts.find((font) => !font.missing) ?? null;

  const save = useMutation({
    mutationFn: (job: SceneJob) => job.run(),
    onSuccess: async (_result, job) => {
      toaster.create({ type: "success", title: job.success });
      await invalidate();
    },
    onError: (reason) => toaster.create({ type: "error", title: "Scene not saved", description: failureMessage(reason, "Scene template could not be saved") }),
  });
  const busy = save.isPending ? save.variables.key : null;
  const request = (job: SceneJob) => save.mutateAsync(job).then(() => true, () => false);

  async function remove(scene: SceneTemplateCard) {
    const confirmed = await confirm({ title: `Delete "${scene.name}"?`, description: "Clips that already use it keep their copy.", confirmLabel: "Delete", destructive: true });
    if (!confirmed) return;
    await request({ key: scene.id, success: "Scene deleted", run: () => mutations.deleteScene(profileId, scene.id, { expectedRevision: scene.revision }) });
  }

  const newScene = !canManage ? null : createRequirement === null ? (
    <Button onClick={() => setComposing(true)}><Plus size={14} /> New scene</Button>
  ) : createUpgrade ? (
    <LockedButton prompt={createUpgrade}>New scene</LockedButton>
  ) : null;

  return (
    <Stack gap="5">
      {scenes.length > 0 ? <TabToolbar summary={plural(scenes.length, "scene")} action={newScene} /> : null}
      {canManage && createRequirement && !createUpgrade ? <PlanLimitNotice message={createRequirement} upgrade={null} /> : null}

      {scenes.length === 0 ? (
        <EmptyState icon={<Type size={20} />} title="No reusable scenes yet" description="Start with an intro, transition card, or closing call to action." action={newScene ? <Box>{newScene}</Box> : undefined} />
      ) : (
        <Grid templateColumns={STYLE_GRID_COLUMNS} gap="4" rowGap="5">
          {scenes.map((scene) => {
            const content = scene.definition.content;
            const canDefault = scene.role !== "inline" && !scene.isDefault;
            return (
              <Stack key={scene.id} gap="2.5" minW="0">
                <Box position="relative">
                  <ScenePreview
                    text={content.kind === "text" ? content.text : scene.name}
                    color={content.kind === "text" ? content.color : "#FFFFFF"}
                    backgroundColor={content.kind === "text" ? content.backgroundColor : content.kind === "color" ? content.color : "#111827"}
                    fontFamily={content.kind === "text" ? content.fontFamily : "inherit"}
                  />
                  <Flex position="absolute" top="2" left="2" right="2" justify="space-between" pointerEvents="none">
                    <CoverChip icon={scene.isDefault ? <Check size={12} /> : undefined}>{scene.isDefault ? `Default ${scene.role}` : ROLE_LABEL[scene.role]}</CoverChip>
                  </Flex>
                  <Box position="absolute" bottom="2" right="2" pointerEvents="none">
                    <CoverChip>
                      <chakra.span fontFamily="mono" fontVariantNumeric="tabular-nums">{scene.definition.durationSec.toFixed(1)}s</chakra.span>
                    </CoverChip>
                  </Box>
                </Box>
                <Flex align="center" justify="space-between" gap="1" h="6" minW="0">
                  <Text fontSize="13px" fontWeight="500" truncate>{scene.name}</Text>
                  {canManage ? (
                    <Menu.Root positioning={{ placement: "bottom-end", gutter: 4 }}>
                      <Menu.Trigger asChild>
                        <IconButton size="xs" variant="ghost" aria-label={`Actions for ${scene.name}`} disabled={busy !== null}>
                          <MoreVertical size={14} />
                        </IconButton>
                      </Menu.Trigger>
                      <Portal>
                        <Menu.Positioner>
                          <Menu.Content>
                            {canDefault && canManageDefaults ? (
                              <Menu.Item value="default" onClick={() => void request({ key: scene.id, success: `Default ${scene.role} updated`, run: () => mutations.updateScene(profileId, scene.id, { expectedRevision: scene.revision, makeDefault: true }) })}>
                                <Star size={14} /> Make default {scene.role}
                              </Menu.Item>
                            ) : null}
                            {canDefault && !canManageDefaults && defaultsUpgrade ? (
                              <LockedMenuItem prompt={defaultsUpgrade} label={`Make default ${scene.role}`} />
                            ) : null}
                            <Menu.Item value="delete" color="danger.fg" onClick={() => void remove(scene)}>
                              <Trash2 size={14} /> Delete
                            </Menu.Item>
                          </Menu.Content>
                        </Menu.Positioner>
                      </Portal>
                    </Menu.Root>
                  ) : null}
                </Flex>
              </Stack>
            );
          })}
        </Grid>
      )}

      {canManage ? (
        <SceneComposer
          open={composing}
          onClose={() => setComposing(false)}
          colors={colors}
          fontFamily={activeFont?.family ?? "Archivo"}
          canManageDefaults={canManageDefaults}
          saving={busy === "create"}
          defaultsNotice={defaultsRequirement && defaultsUpgrade ? { message: defaultsRequirement, upgrade: defaultsUpgrade } : null}
          onCreate={async (input) => {
            const body = {
              name: input.name.trim(), role: input.role, makeDefault: canManageDefaults && input.role !== "inline" && input.makeDefault,
              definition: { schemaVersion: 1 as const, durationSec: input.durationSec, content: { kind: "text" as const, text: input.text.trim(), fontFamily: activeFont?.family ?? "Archivo", fontAsset: activeFont ? { kind: "brand_font" as const, id: activeFont.id, fingerprint: activeFont.fingerprint } : null, color: input.color, backgroundColor: input.backgroundColor }, motion: { entrance: "fade" as const, exit: "fade" as const } },
            };
            // The same draft keeps its idempotency key through retries; a changed one is a new scene.
            const ok = await request({ key: "create", success: "Scene saved", run: () => mutations.createScene(profileId, body, createIntent.keyFor(body)) });
            if (ok) {
              createIntent.complete();
              setComposing(false);
            }
            return ok;
          }}
        />
      ) : null}
      {dialog}
    </Stack>
  );
}

/** A menu action the plan doesn't include: it stays listed with a gem and opens the upgrade. */
function LockedMenuItem({ prompt, label }: { prompt: UpgradePrompt; label: string }) {
  const { openUpgrade } = useUpgrade();
  return (
    <Menu.Item value="default-locked" onClick={() => openUpgrade(prompt)}>
      <Star size={14} /> {label}
      <Box as="span" ms="auto" color="upgrade.fg" display="inline-flex">
        <Gem size={12} aria-hidden />
      </Box>
    </Menu.Item>
  );
}

interface SceneDraft {
  name: string;
  text: string;
  role: SceneTemplateRole;
  durationSec: number;
  color: string;
  backgroundColor: string;
  makeDefault: boolean;
}

function uniqueColors(values: (string | null)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase()))];
}

function SwatchPicker({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <Stack gap="2">
      <Text fontSize="13px" fontWeight="500">{label}</Text>
      <Flex role="radiogroup" aria-label={label} gap="2" wrap="wrap">
        {options.map((option) => {
          const selected = option === value.toUpperCase();
          return (
            <chakra.button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label} ${option}`}
              boxSize="8"
              borderRadius="full"
              cursor="pointer"
              outline="2px solid"
              outlineColor={selected ? "accent.solid" : "transparent"}
              outlineOffset="2px"
              boxShadow={SWATCH_RING}
              transition="outline-color 120ms ease, transform 120ms ease"
              _hover={{ transform: "scale(1.08)" }}
              style={{ background: option }}
              onClick={() => onChange(option)}
            />
          );
        })}
      </Flex>
    </Stack>
  );
}

function SceneComposer({ open, onClose, colors, fontFamily, canManageDefaults, defaultsNotice, saving, onCreate }: { open: boolean; onClose: () => void; colors: BrandColors; fontFamily: string; canManageDefaults: boolean; /** Why the plan can't make it a default, with the upgrade that can. */ defaultsNotice: { message: string; upgrade: UpgradePrompt } | null; saving: boolean; onCreate: (draft: SceneDraft) => Promise<boolean> }) {
  const initial = (): SceneDraft => ({ name: "", text: "Opening title", role: "intro", durationSec: 3, color: colors.primaryColor.toUpperCase(), backgroundColor: colors.secondaryColor.toUpperCase(), makeDefault: true });
  const [draft, setDraft] = useState<SceneDraft>(initial);
  const set = <K extends keyof SceneDraft>(key: K, value: SceneDraft[K]) => setDraft((prior) => ({ ...prior, [key]: value }));
  const palette = uniqueColors([colors.primaryColor, colors.secondaryColor, colors.accentColor, "#FFFFFF", "#000000"]);
  const valid = draft.name.trim().length > 0 && draft.text.trim().length > 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (details.open || saving) return;
        onClose();
        setDraft(initial());
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="3xl">
            <Dialog.Header>
              <Dialog.Title>New scene</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Grid templateColumns={{ base: "1fr", md: "minmax(0, 1fr) 220px" }} gap="8" alignItems="start">
                <Stack gap="5">
                  <Stack gap="1.5">
                    <chakra.label htmlFor="scene-name" fontSize="13px" fontWeight="500">Name</chakra.label>
                    <Input id="scene-name" aria-label="Template name" placeholder="Launch opener" value={draft.name} onChange={(event) => set("name", event.target.value.slice(0, 120))} />
                  </Stack>
                  <Stack gap="1.5">
                    <chakra.label htmlFor="scene-text" fontSize="13px" fontWeight="500">Card text</chakra.label>
                    <Input id="scene-text" aria-label="Card text" placeholder="Opening title" value={draft.text} onChange={(event) => set("text", event.target.value.slice(0, 500))} />
                  </Stack>
                  <Stack gap="1.5">
                    <Text fontSize="13px" fontWeight="500">Plays as</Text>
                    <SegmentedControl aria-label="Scene role" items={ROLE_OPTIONS} value={draft.role} onValueChange={(value) => set("role", value as SceneTemplateRole)} alignSelf="flex-start" />
                  </Stack>
                  <Slider label="Duration" showValueText min={1} max={30} step={0.5} value={draft.durationSec} onValueChange={(value) => set("durationSec", Array.isArray(value) ? (value[0] ?? 1) : value)} />
                  <Grid templateColumns="1fr 1fr" gap="5">
                    <SwatchPicker label="Background" value={draft.backgroundColor} options={palette} onChange={(value) => set("backgroundColor", value)} />
                    <SwatchPicker label="Text" value={draft.color} options={palette} onChange={(value) => set("color", value)} />
                  </Grid>
                  {canManageDefaults && draft.role !== "inline" ? (
                    <Checkbox size="sm" checked={draft.makeDefault} onCheckedChange={(checked) => set("makeDefault", checked)}>
                      Make it this profile&apos;s default {draft.role}
                    </Checkbox>
                  ) : draft.role !== "inline" && defaultsNotice ? (
                    <PlanLimitNotice message={defaultsNotice.message} upgrade={defaultsNotice.upgrade} />
                  ) : null}
                </Stack>
                <Stack gap="2" position={{ md: "sticky" }} top="0">
                  <ScenePreview large text={draft.text || "Opening title"} color={draft.color} backgroundColor={draft.backgroundColor} fontFamily={fontFamily} />
                  <Flex justify="space-between" fontSize="12px" color="fg.subtle">
                    <Text>{ROLE_LABEL[draft.role]}</Text>
                    <Text fontFamily="mono" fontVariantNumeric="tabular-nums">{draft.durationSec.toFixed(1)}s</Text>
                  </Flex>
                </Stack>
              </Grid>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="subtle" disabled={saving} onClick={() => { onClose(); setDraft(initial()); }}>Cancel</Button>
              <Button loading={saving} disabled={!valid} onClick={() => void onCreate(draft).then((ok) => { if (ok) setDraft(initial()); })}>Save scene</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
