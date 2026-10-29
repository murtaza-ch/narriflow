"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { isApiError, type Intent } from "@narriflow/api-client/core";
import type { RecipesActions } from "@narriflow/api-client/recipes";
import { useMutation } from "@tanstack/react-query";
import { Box, chakra, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, ArrowUpRight, Bot, Copy, Languages, Pencil, Plus, Scissors, Sparkles, Timer, Trash2, Zap } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Select } from "@narriflow/ui/components/select";
import { Slider } from "@narriflow/ui/components/slider";
import { Switch } from "@narriflow/ui/components/switch";
import { toaster } from "@narriflow/ui/components/toaster";
import { useOpenAfterMount } from "@narriflow/ui/components/use-open-after-mount";
import { clipAspectRatioOptions, type ClipLengthPreset, type ContentPack, type RecipeSnapshot, recipeWarningSchema, type SocialPlatform } from "@narriflow/validators";
import { docsUrl } from "@/lib/docs-url";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { FeatureHero } from "../_components/feature-hero";
import { RecipeVisual } from "../_components/upgrade-visuals";
import { LANGUAGE_OPTIONS } from "../_shared/languages";
import { InlineLabel, SettingsSection, SliderField, ToggleCard } from "../_shared/settings-fields";
import { clipLengthItems, RatioIcon } from "../upload/_components/format-settings";
import { LanguageSelect } from "../upload/_components/language-select";
import { BrandProfileSelect, type RecipeBrandProfile } from "./brand-profile-select";
import { FinishingFields } from "./finishing-fields";
import { describeFinishing } from "./finishing-form";
import { describeRecipeWarnings, draftFromRecipe, emptyRecipeDraft, recipeChanges, recipeFromDraft, type ParsedRecipeInput, type RecipeDraft } from "./recipe-form";
import { BrandMark, type BrandColors } from "../brand-kit/_components/brand-kit-ui";

/** A failed Recipe command's sentence: the server's own text, or the network wording when nothing answered. */
function recipeFailureMessage(error: unknown): string {
  if (isApiError(error)) return error.code === "network_error" ? "Network error — please try again." : error.message;
  return error instanceof Error && error.message ? error.message : "Request failed";
}

/** What the panel needs to change Recipes: the commands, one idempotency intent per create or duplicate, and the cache refresh. */
export interface RecipesPanelApi {
  actions: RecipesActions;
  createIntent<TInput>(): Intent<TInput>;
  /** Refreshes what a created, changed, duplicated or deleted Recipe touches. */
  changed(): Promise<void>;
}

const languageLabel = (code: string | null) =>
  code ? (LANGUAGE_OPTIONS.find((option) => option.code === code)?.label.split(" · ")[0] ?? code) : "Auto-detect language";

const ratioItems = clipAspectRatioOptions.map((option) => ({
  value: option.value,
  label: (
    <Flex align="center" gap="1.5">
      <RatioIcon ratio={option.value} />
      {option.value}
    </Flex>
  ),
}));

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <Box>
      <chakra.label htmlFor={htmlFor} display="block" fontSize="13px" fontWeight="500" color="fg" mb="1.5">
        {label}
      </chakra.label>
      {children}
    </Box>
  );
}

/** How a Brand Profile looks, for drawing a Recipe's clips in its colors. */
export interface RecipeBrandLook {
  colors: BrandColors;
  logoUrl: string | null;
}

export function RecipesPanel({
  recipes,
  brandProfiles,
  brandLooks = {},
  canEdit,
  finishingAvailable,
  queueAccounts,
  api,
}: {
  recipes: RecipeSnapshot[];
  brandProfiles: RecipeBrandProfile[];
  brandLooks?: Record<string, RecipeBrandLook>;
  /** Members who can edit content can save Recipes; others read them. */
  canEdit: boolean;
  /** Finishing needs the Pro plan; a Recipe below it still imports and generates clips. */
  finishingAvailable: boolean;
  queueAccounts: Array<{ id: string; platform: SocialPlatform; displayName: string }>;
  api: RecipesPanelApi;
}) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  // `null` is closed, "new" is a blank form, and a Recipe is its edit form.
  const [editing, setEditing] = useState<RecipeSnapshot | "new" | null>(null);
  const [pending, setPending] = useState<Record<string, "duplicate" | "delete" | undefined>>({});
  const defaultBrandProfileId = brandProfiles.find((profile) => profile.isDefault)?.id ?? null;

  // One idempotency key per duplicate click, kept through a failed or lost attempt so a retry
  // replays the first copy instead of saving a second.
  const duplicateIntents = useRef(new Map<string, Intent<string>>());
  const duplicate = useMutation({
    mutationFn: (recipe: RecipeSnapshot) => {
      const intent = duplicateIntents.current.get(recipe.id) ?? api.createIntent<string>();
      duplicateIntents.current.set(recipe.id, intent);
      return api.actions.duplicate(recipe.id, intent.keyFor(recipe.id));
    },
    onSuccess: async (_copy, recipe) => {
      duplicateIntents.current.delete(recipe.id);
      await api.changed();
    },
  });
  const deleteRecipe = useMutation({
    mutationFn: (recipe: RecipeSnapshot) => api.actions.remove(recipe.id),
    onSuccess: () => api.changed(),
  });

  async function act(recipe: RecipeSnapshot, action: "duplicate" | "delete") {
    setPending((current) => ({ ...current, [recipe.id]: action }));
    try {
      await (action === "duplicate" ? duplicate : deleteRecipe).mutateAsync(recipe);
      toaster.create({ type: "success", title: action === "duplicate" ? "Recipe duplicated" : "Recipe deleted", description: recipe.name });
    } catch (error) {
      toaster.create({ type: "error", title: action === "duplicate" ? "Could not duplicate Recipe" : "Could not delete Recipe", description: recipeFailureMessage(error) });
    } finally {
      setPending((current) => ({ ...current, [recipe.id]: undefined }));
    }
  }

  async function remove(recipe: RecipeSnapshot) {
    const confirmed = await confirm({
      title: `Delete "${recipe.name}"?`,
      description: "Work already imported keeps the settings it used. Assistants and API calls that name this Recipe will stop working.",
      confirmLabel: "Delete Recipe",
      destructive: true,
    });
    if (confirmed) await act(recipe, "delete");
  }

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Recipes"
          actions={
            canEdit ? (
              <Button onClick={() => setEditing("new")}>
                <Plus size={15} strokeWidth={2} aria-hidden />
                New Recipe
              </Button>
            ) : undefined
          }
        />
      </Box>

      <Box as="section" animation="fade-up" animationDelay="80ms" animationFillMode="backwards">
        {recipes.length === 0 ? (
          <FeatureHero
            title="Reuse your settings on every new video"
            points={[
              "Brand, language, clip and finishing settings in one place.",
              "Autopilot rules and assistants pick it by name; edits apply to new work only.",
            ]}
            visual={<RecipeVisual />}
            action={
              <Flex align="center" gap="2" wrap="wrap">
                {canEdit ? (
                  <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus size={15} strokeWidth={2} aria-hidden />
                    Create your first Recipe
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="ghost">
                  <a href={docsUrl("recipes")} target="_blank" rel="noreferrer">
                    How Recipes work
                    <ArrowUpRight size={14} aria-hidden />
                  </a>
                </Button>
              </Flex>
            }
          />
        ) : (
          <Grid templateColumns={{ base: "1fr", lg: "repeat(2, minmax(0, 1fr))" }} gap="4">
            {recipes.map((recipe) => {
              const brand = recipe.brandProfileId ? brandProfiles.find((profile) => profile.id === recipe.brandProfileId) : null;
              const brandName = recipe.brandProfileId ? (brand?.name ?? "Unavailable Brand Profile") : null;
              const look = recipe.brandProfileId ? (brandLooks[recipe.brandProfileId] ?? null) : null;
              const busy = pending[recipe.id];
              const { contentPack } = recipe;
              return (
                <Stack key={recipe.id} as="article" gap="5" bg="bg.subtle" borderRadius="l3" p="5" minW="0">
                  <Flex gap="4" align="flex-start" minW="0">
                    <ClipGlyph ratio={contentPack.defaultAspectRatio} colors={look?.colors ?? null} />
                    <Stack gap="1.5" minW="0" flex="1" pt="0.5">
                      {canEdit ? (
                        <chakra.button
                          type="button"
                          onClick={() => setEditing(recipe)}
                          textAlign="left"
                          fontSize="15px"
                          fontWeight="500"
                          color="fg"
                          cursor="pointer"
                          truncate
                          maxW="full"
                          _hover={{ textDecoration: "underline", textUnderlineOffset: "3px" }}
                        >
                          {recipe.name}
                        </chakra.button>
                      ) : (
                        <Text fontSize="15px" fontWeight="500" color="fg" truncate>
                          {recipe.name}
                        </Text>
                      )}
                      <Flex align="center" gap="2" minW="0" fontSize="13px" color="fg.muted">
                        {look && brand ? <BrandMark colors={look.colors} logoUrl={look.logoUrl} name={brand.name} size={18} /> : null}
                        <Text truncate>{brandName ? `Brand: ${brandName}` : "No Brand Profile"}</Text>
                      </Flex>
                    </Stack>
                    {canEdit ? (
                      <Flex gap="0.5" align="center" flexShrink={0} mt="-1" me="-1">
                        <IconButton size="xs" variant="ghost" aria-label={`Edit Recipe ${recipe.name}`} disabled={busy !== undefined} onClick={() => setEditing(recipe)}>
                          <Pencil size={14} strokeWidth={1.75} />
                        </IconButton>
                        <IconButton size="xs" variant="ghost" aria-label={`Duplicate Recipe ${recipe.name}`} loading={busy === "duplicate"} disabled={busy !== undefined && busy !== "duplicate"} onClick={() => void act(recipe, "duplicate")}>
                          <Copy size={14} strokeWidth={1.75} />
                        </IconButton>
                        <IconButton
                          size="xs"
                          variant="ghost"
                          colorPalette="danger"
                          aria-label={`Delete Recipe ${recipe.name}`}
                          title={recipe.ruleCount > 0 ? "An Autopilot rule uses this Recipe. Move the rule to another Recipe first." : undefined}
                          loading={busy === "delete"}
                          disabled={recipe.ruleCount > 0 || (busy !== undefined && busy !== "delete")}
                          onClick={() => void remove(recipe)}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </IconButton>
                      </Flex>
                    ) : null}
                  </Flex>

                  <Flex gap="1.5" wrap="wrap" aria-label="Settings">
                    <SettingChip icon={<RatioIcon ratio={contentPack.defaultAspectRatio} />}>{contentPack.defaultAspectRatio}</SettingChip>
                    <SettingChip icon={<Scissors size={12} />}>{`${contentPack.clipCountTarget} clips`}</SettingChip>
                    <SettingChip icon={<Timer size={12} />}>{contentPack.clipLengthPreset === "auto" ? "Auto length" : (clipLengthItems.find((item) => item.value === contentPack.clipLengthPreset)?.label ?? "Auto length")}</SettingChip>
                    <SettingChip icon={<Languages size={12} />}>{languageLabel(recipe.languageCode)}</SettingChip>
                    {contentPack.autoHook ? <SettingChip icon={<Zap size={12} />}>Hook first</SettingChip> : null}
                  </Flex>

                  {recipe.finishing ? (
                    <Flex gap="2.5" align="flex-start" px="3" py="2.5" borderRadius="l2" bg={finishingAvailable ? "accent.subtle" : "upgrade.subtle"}>
                      <Box mt="0.5" color={finishingAvailable ? "accent.fg" : "upgrade.fg"} flexShrink={0}>
                        <Sparkles size={13} />
                      </Box>
                      <Text fontSize="12.5px" color={finishingAvailable ? "fg" : "upgrade.fg"} lineHeight="1.45">
                        {finishingAvailable
                          ? `Finishing: ${describeFinishing(recipe.finishing, (platform) => SOCIAL_PLATFORM_LABELS[platform])}`
                          : "Finishing is off: it needs the Pro plan. New videos still import and generate clips."}
                      </Text>
                    </Flex>
                  ) : null}

                  <Flex align="center" gap="2" mt="auto" fontSize="12px" color="fg.subtle">
                    <Bot size={13} aria-hidden />
                    <Text>
                      {recipe.ruleCount === 0 ? (
                        "Not used by an Autopilot rule"
                      ) : (
                        <>
                          <chakra.span asChild color="accent.fg" fontWeight="500" textDecoration="underline" textDecorationColor="transparent" textUnderlineOffset="3px" _hover={{ textDecorationColor: "currentColor" }}>
                            <Link href="/autopilot">{`Used by ${recipe.ruleCount} Autopilot rule${recipe.ruleCount === 1 ? "" : "s"}`}</Link>
                          </chakra.span>
                          {/* Says why Delete is off, where touch users can read it. */}
                          {canEdit ? ` · move ${recipe.ruleCount === 1 ? "it" : "them"} to another Recipe to delete this one` : ""}
                        </>
                      )}
                    </Text>
                  </Flex>
                </Stack>
              );
            })}
          </Grid>
        )}
      </Box>

      <RecipeDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        target={editing}
        brandProfiles={brandProfiles}
        defaultBrandProfileId={defaultBrandProfileId}
        finishingAvailable={finishingAvailable}
        queueAccounts={queueAccounts}
        api={api}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
      {confirmDialog}
    </Stack>
  );
}

/** A setting as a soft chip with its icon. */
function SettingChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Flex align="center" gap="1.5" h="7" px="2.5" borderRadius="8px" bg="bg.soft" color="fg" fontSize="12.5px" fontWeight="500" whiteSpace="nowrap">
      <Flex color="fg.muted" align="center">{icon}</Flex>
      {children}
    </Flex>
  );
}

/**
 * The Recipe's clip in miniature: its frame shape, drawn in the Brand
 * Profile's colors (secondary ground, primary caption, signal highlight).
 */
function ClipGlyph({ ratio, colors }: { ratio: ContentPack["defaultAspectRatio"]; colors: BrandColors | null }) {
  const frame = { "9:16": { w: 26, h: 44 }, "4:5": { w: 34, h: 42 }, "1:1": { w: 40, h: 40 }, "16:9": { w: 48, h: 28 } }[ratio];
  const ground = colors?.secondaryColor ?? "var(--chakra-colors-studio-raised)";
  const caption = colors?.primaryColor ?? "#FFFFFF";
  const highlight = colors?.accentColor ?? "var(--chakra-colors-accent-solid)";
  return (
    <Flex boxSize="14" flexShrink={0} align="center" justify="center" borderRadius="12px" bg="bg.soft" aria-hidden>
      <Flex direction="column" justify="flex-end" align="center" gap="2px" pb="22%" borderRadius="5px" style={{ width: frame.w, height: frame.h, background: ground }}>
        <Flex gap="2px">
          <Box h="3px" w="7px" borderRadius="full" style={{ background: caption }} />
          <Box h="3px" w="6px" borderRadius="full" style={{ background: highlight }} />
        </Flex>
        <Box h="3px" w="11px" borderRadius="full" opacity={0.7} style={{ background: caption }} />
      </Flex>
    </Flex>
  );
}

function RecipeDialog({
  target,
  brandProfiles,
  defaultBrandProfileId,
  finishingAvailable,
  queueAccounts,
  api,
  onClose,
  onSaved,
}: {
  target: RecipeSnapshot | "new" | null;
  brandProfiles: RecipeBrandProfile[];
  defaultBrandProfileId: string | null;
  finishingAvailable: boolean;
  queueAccounts: Array<{ id: string; platform: SocialPlatform; displayName: string }>;
  api: RecipesPanelApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recipe = target !== null && target !== "new" ? target : null;
  const hookLabelId = useId();
  // The parent keys this dialog by Recipe, so every open starts a fresh draft.
  const [opened] = useState<RecipeDraft>(() => (recipe ? draftFromRecipe(recipe) : emptyRecipeDraft(defaultBrandProfileId)));
  const [draft, setDraft] = useState<RecipeDraft>(opened);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key for this dialog's create, kept through a failed or lost attempt.
  const [createIntent] = useState(() => api.createIntent<ParsedRecipeInput>());
  const saveRecipe = useMutation({
    mutationFn: ({ input, changes }: { input: ParsedRecipeInput; changes: ReturnType<typeof recipeChanges> | null }) =>
      recipe && changes
        ? api.actions.update(recipe.id, { ...changes, expectedRevision: recipe.revision })
        : api.actions.create(input, createIntent.keyFor(input)),
    onSuccess: async () => {
      if (!recipe) createIntent.complete();
      await api.changed();
    },
  });
  const saving = saveRecipe.isPending;
  const set = (patch: Partial<RecipeDraft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    const result = recipeFromDraft(draft, recipe?.contentPack);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // Send only what changed, on top of the revision this form was opened at.
    const changes = recipe ? recipeChanges(result.input, recipe, JSON.stringify(draft.finishing) !== JSON.stringify(opened.finishing)) : null;
    if (changes && Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setError(null);
    let saved: Awaited<ReturnType<typeof saveRecipe.mutateAsync>>;
    try {
      saved = await saveRecipe.mutateAsync({ input: result.input, changes });
    } catch (failure) {
      setError(recipeFailureMessage(failure));
      return;
    }
    toaster.create({ type: "success", title: recipe ? "Recipe updated" : "Recipe created", description: draft.name.trim() });
    // The save went through; this says which rules won't do everything it asks.
    const warnings = recipeWarningSchema.array().safeParse("warnings" in saved ? saved.warnings : []);
    const warning = recipe && warnings.success ? describeRecipeWarnings(warnings.data) : null;
    if (warning) toaster.create({ type: "warning", title: "Some rules can't propose posts", description: warning });
    onSaved();
  }

  // A target opens this dialog already open (its key changes with the target); see useOpenAfterMount.
  const open = useOpenAfterMount(target !== null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (saving || details.open) return;
        onClose();
      }}
      placement="center"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="520px">
            <Dialog.Header px="6" pt="5" pb="4">
              <Stack gap="0.5">
                <Dialog.Title textStyle="title" fontSize="18px" color="fg">
                  {recipe ? "Edit Recipe" : "New Recipe"}
                </Dialog.Title>
                <Text fontSize="13px" color="fg.muted">
                  New videos start from these settings.
                </Text>
              </Stack>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" borderRadius="full" aria-label="Close" />
            </Dialog.CloseTrigger>
            <Dialog.Body px="6" py="1">
              <Stack gap="7">
                <Field label="Name" htmlFor="recipe-name">
                  <Input id="recipe-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Weekly podcast" fontSize="14px" />
                </Field>

                <SettingsSection title="Clips">
                  <BrandProfileSelect profiles={brandProfiles} value={draft.brandProfileId} onChange={(brandProfileId) => set({ brandProfileId })} />
                  <SegmentedControl
                    aria-label="Format"
                    items={ratioItems}
                    value={draft.defaultAspectRatio}
                    onValueChange={(value) => set({ defaultAspectRatio: value as ContentPack["defaultAspectRatio"] })}
                    size="md"
                    w="full"
                    css={{ "& > [data-part=item]": { flex: "1", justifyContent: "center" } }}
                  />
                  <Select
                    ariaLabel="Clip length"
                    items={clipLengthItems}
                    value={draft.clipLengthPreset}
                    onValueChange={(value) => set({ clipLengthPreset: value as ClipLengthPreset })}
                    startElement={<InlineLabel>Clip length</InlineLabel>}
                    size="md"
                  />
                  <LanguageSelect value={draft.languageCode} onChange={(languageCode) => set({ languageCode })} />
                  <Box pt="1">
                    <SliderField label="Clips per video" value={draft.clipCountTarget}>
                      <Slider
                        aria-label={["Clips per video"]}
                        min={3}
                        max={30}
                        step={1}
                        value={Number(draft.clipCountTarget) || 10}
                        onValueChange={(value) => set({ clipCountTarget: String(value) })}
                      />
                    </SliderField>
                  </Box>
                  <ToggleCard labelId={hookLabelId} title="Start with a hook" description="Prioritize attention-grabbing openings.">
                    <Switch checked={draft.autoHook} onCheckedChange={(autoHook) => set({ autoHook })} inputProps={{ "aria-labelledby": hookLabelId }} />
                  </ToggleCard>
                </SettingsSection>

                <SettingsSection title="Finishing">
                  <FinishingFields idPrefix="recipe-finishing" draft={draft.finishing} onChange={(finishing) => set({ finishing })} available={finishingAvailable} queueAccounts={queueAccounts} />
                </SettingsSection>

                {error ? (
                  <Flex align="center" gap="2" color="danger.fg">
                    <AlertTriangle size={13} strokeWidth={2} aria-hidden />
                    <Text fontSize="12.5px" fontWeight="500">
                      {error}
                    </Text>
                  </Flex>
                ) : null}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer px="6" pt="5" pb="5" gap="2">
              <Dialog.ActionTrigger asChild>
                <Button variant="subtle" size="sm" disabled={saving}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {recipe ? "Save" : "Create Recipe"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
