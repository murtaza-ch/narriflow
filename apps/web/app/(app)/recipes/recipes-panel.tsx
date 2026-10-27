"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, BookMarked, Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Select } from "@narriflow/ui/components/select";
import { Switch } from "@narriflow/ui/components/switch";
import { toaster } from "@narriflow/ui/components/toaster";
import { clipAspectRatioOptions, type ClipLengthPreset, type ContentPack, type RecipeSnapshot, type RecipeWarning, type SocialPlatform } from "@narriflow/validators";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { LANGUAGE_OPTIONS } from "../_shared/languages";
import { clipLengthItems } from "../upload/_components/format-settings";
import { LanguageSelect } from "../upload/_components/language-select";
import { BrandProfileSelect, type RecipeBrandProfile } from "./brand-profile-select";
import { FinishingFields } from "./finishing-fields";
import { describeFinishing } from "./finishing-form";
import { describeRecipeGeneration, describeRecipeWarnings, draftFromRecipe, emptyRecipeDraft, recipeChanges, recipeFromDraft, type RecipeDraft } from "./recipe-form";

async function request(url: string, init?: RequestInit, onSaved?: (body: unknown) => void): Promise<string | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      return payload?.message ?? payload?.error ?? "Request failed";
    }
    if (onSaved) onSaved(await response.json().catch(() => null));
    return null;
  } catch {
    return "Network error — please try again.";
  }
}

const languageLabel = (code: string | null) =>
  code ? (LANGUAGE_OPTIONS.find((option) => option.code === code)?.label.split(" · ")[0] ?? code) : "Auto-detect language";

const ratioItems = clipAspectRatioOptions.map((option) => ({ value: option.value, label: option.value }));

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

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="fg.muted" mb="2.5">
        {label}
      </Text>
      <Stack gap="3">{children}</Stack>
    </Box>
  );
}

export function RecipesPanel({
  initialRecipes,
  brandProfiles,
  canEdit,
  finishingAvailable,
  queueAccounts,
}: {
  initialRecipes: RecipeSnapshot[];
  brandProfiles: RecipeBrandProfile[];
  /** Members who can edit content can save Recipes; others read them. */
  canEdit: boolean;
  /** Finishing needs the Pro plan; a Recipe below it still imports and generates clips. */
  finishingAvailable: boolean;
  queueAccounts: Array<{ id: string; platform: SocialPlatform; displayName: string }>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // `null` is closed, "new" is a blank form, and a Recipe is its edit form.
  const [editing, setEditing] = useState<RecipeSnapshot | "new" | null>(null);
  const [pending, setPending] = useState<Record<string, "duplicate" | "delete" | undefined>>({});
  const defaultBrandProfileId = brandProfiles.find((profile) => profile.isDefault)?.id ?? null;
  const refresh = () => startTransition(() => router.refresh());

  async function act(recipe: RecipeSnapshot, action: "duplicate" | "delete") {
    setPending((current) => ({ ...current, [recipe.id]: action }));
    const error =
      action === "duplicate"
        ? await request(`/api/recipes/${recipe.id}/duplicate`, { method: "POST" })
        : await request(`/api/recipes/${recipe.id}`, { method: "DELETE" });
    setPending((current) => ({ ...current, [recipe.id]: undefined }));
    if (error) {
      toaster.create({ type: "error", title: action === "duplicate" ? "Could not duplicate Recipe" : "Could not delete Recipe", description: error });
      return;
    }
    toaster.create({ type: "success", title: action === "duplicate" ? "Recipe duplicated" : "Recipe deleted", description: recipe.name });
    refresh();
  }

  async function remove(recipe: RecipeSnapshot) {
    const confirmed = await confirm({
      title: "Delete this Recipe?",
      description: "Work already imported keeps the settings it used. Assistants and API calls that name this Recipe will stop working.",
      confirmLabel: "Delete Recipe",
      destructive: true,
    });
    if (confirmed) await act(recipe, "delete");
  }

  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Recipes"
          description="Saved settings for new work: Brand Profile, language, clip settings, and finishing. Autopilot rules and assistants use a Recipe by name, so one edit changes what comes next and nothing already made."
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
        {initialRecipes.length === 0 ? (
          <EmptyState
            icon={<BookMarked size={20} strokeWidth={1.75} />}
            title="No Recipes yet"
            description="Save your usual settings once, then reuse them in Autopilot rules and with your assistants."
            action={
              canEdit ? (
                <Button variant="plain" size="sm" color="fg.accent" fontWeight="600" onClick={() => setEditing("new")}>
                  Create your first Recipe
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Stack gap="3">
            {initialRecipes.map((recipe) => {
              const brandName = recipe.brandProfileId
                ? (brandProfiles.find((profile) => profile.id === recipe.brandProfileId)?.name ?? "Unavailable Brand Profile")
                : null;
              const busy = pending[recipe.id];
              return (
                <Flex key={recipe.id} bg="bg.subtle" borderRadius="l3" px="5" py="4" gap="4" align="center" wrap="wrap">
                  <Box minW="0" flex="1">
                    <Text fontSize="14px" textStyle="title" color="fg" truncate>
                      {recipe.name}
                    </Text>
                    <Text mt="1" fontSize="13px" color="fg.muted">
                      {describeRecipeGeneration(recipe, languageLabel)}
                      {brandName ? ` · Brand: ${brandName}` : ""}
                    </Text>
                    {recipe.finishing ? (
                      <Text mt="1" fontSize="12px" color={finishingAvailable ? "fg.subtle" : "warning.fg"}>
                        {finishingAvailable
                          ? `Finishing: ${describeFinishing(recipe.finishing, (platform) => SOCIAL_PLATFORM_LABELS[platform])}`
                          : "Finishing is off: it needs the Pro plan. New videos still import and generate clips."}
                      </Text>
                    ) : null}
                    <Text mt="1.5" fontSize="12px" color="fg.subtle">
                      {recipe.ruleCount === 0 ? (
                        "Not used by an Autopilot rule"
                      ) : (
                        <>
                          <chakra.span asChild textDecoration="underline" textUnderlineOffset="3px">
                            <Link href="/autopilot">{`Used by ${recipe.ruleCount} Autopilot rule${recipe.ruleCount === 1 ? "" : "s"}`}</Link>
                          </chakra.span>
                          {/* Says why Delete is off, where touch users can read it. */}
                          {canEdit ? ` · move ${recipe.ruleCount === 1 ? "it" : "them"} to another Recipe to delete this one` : ""}
                        </>
                      )}
                    </Text>
                  </Box>
                  {canEdit ? (
                    <Flex gap="1" align="center" flexShrink={0}>
                      <IconButton size="xs" variant="ghost" aria-label={`Edit Recipe ${recipe.name}`} disabled={busy !== undefined} onClick={() => setEditing(recipe)}>
                        <Pencil size={13} strokeWidth={1.75} />
                      </IconButton>
                      <IconButton size="xs" variant="ghost" aria-label={`Duplicate Recipe ${recipe.name}`} loading={busy === "duplicate"} disabled={busy !== undefined && busy !== "duplicate"} onClick={() => void act(recipe, "duplicate")}>
                        <Copy size={13} strokeWidth={1.75} />
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
                        <Trash2 size={13} strokeWidth={1.75} />
                      </IconButton>
                    </Flex>
                  ) : null}
                </Flex>
              );
            })}
          </Stack>
        )}
      </Box>

      <RecipeDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        target={editing}
        brandProfiles={brandProfiles}
        defaultBrandProfileId={defaultBrandProfileId}
        finishingAvailable={finishingAvailable}
        queueAccounts={queueAccounts}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      {confirmDialog}
    </Stack>
  );
}

function RecipeDialog({
  target,
  brandProfiles,
  defaultBrandProfileId,
  finishingAvailable,
  queueAccounts,
  onClose,
  onSaved,
}: {
  target: RecipeSnapshot | "new" | null;
  brandProfiles: RecipeBrandProfile[];
  defaultBrandProfileId: string | null;
  finishingAvailable: boolean;
  queueAccounts: Array<{ id: string; platform: SocialPlatform; displayName: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recipe = target !== null && target !== "new" ? target : null;
  // The parent keys this dialog by Recipe, so every open starts a fresh draft.
  const [opened] = useState<RecipeDraft>(() => (recipe ? draftFromRecipe(recipe) : emptyRecipeDraft(defaultBrandProfileId)));
  const [draft, setDraft] = useState<RecipeDraft>(opened);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setSaving(true);
    let warnings: RecipeWarning[] = [];
    const failure = recipe
      ? await request(
          `/api/recipes/${recipe.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...changes, expectedRevision: recipe.revision }),
          },
          (body) => {
            warnings = (body as { warnings?: RecipeWarning[] } | null)?.warnings ?? [];
          },
        )
      : await request("/api/recipes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result.input) });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    toaster.create({ type: "success", title: recipe ? "Recipe updated" : "Recipe created", description: draft.name.trim() });
    // The save went through; this says which rules won't do everything it asks.
    const warning = describeRecipeWarnings(warnings);
    if (warning) toaster.create({ type: "warning", title: "Some rules can't propose posts", description: warning });
    onSaved();
  }

  return (
    <Dialog.Root
      open={target !== null}
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
          <Dialog.Content maxW="480px">
            <Dialog.Header px="6" pt="5" pb="4">
              <Dialog.Title textStyle="title" fontSize="18px" color="fg">
                {recipe ? "Edit Recipe" : "New Recipe"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild>
              <IconButton aria-label="Close" size="sm" variant="ghost" borderRadius="full" position="absolute" top="3" insetInlineEnd="3">
                <X size={16} />
              </IconButton>
            </Dialog.CloseTrigger>
            <Dialog.Body px="6" py="0">
              <Stack gap="5">
                <Field label="Recipe name" htmlFor="recipe-name">
                  <Input id="recipe-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Weekly podcast" fontSize="13px" size="sm" />
                </Field>

                <FieldGroup label="Output">
                  <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                    <BrandProfileSelect profiles={brandProfiles} value={draft.brandProfileId} onChange={(brandProfileId) => set({ brandProfileId })} />
                    <Field label="Clips per video" htmlFor="recipe-clip-count">
                      <NumberInput value={draft.clipCountTarget} onValueChange={(clipCountTarget) => set({ clipCountTarget })} min={3} max={30} size="sm" inputProps={{ id: "recipe-clip-count" }} />
                    </Field>
                    <Select
                      label="Format"
                      items={ratioItems}
                      value={draft.defaultAspectRatio}
                      onValueChange={(value) => set({ defaultAspectRatio: value as ContentPack["defaultAspectRatio"] })}
                      size="sm"
                    />
                    <Select
                      label="Clip length"
                      items={clipLengthItems}
                      value={draft.clipLengthPreset}
                      onValueChange={(value) => set({ clipLengthPreset: value as ClipLengthPreset })}
                      size="sm"
                    />
                  </SimpleGrid>
                  <Box>
                    <Text fontSize="13px" fontWeight="500" color="fg" mb="1.5">
                      Speech language
                    </Text>
                    <LanguageSelect value={draft.languageCode} onChange={(languageCode) => set({ languageCode })} />
                  </Box>
                  <Flex align="center" justify="space-between" gap="4">
                    <Box minW="0">
                      <Text fontSize="13px" fontWeight="500" color="fg">
                        Add a hook to each clip
                      </Text>
                      <Text fontSize="12px" color="fg.muted">
                        Open each clip with a short line that earns the next few seconds.
                      </Text>
                    </Box>
                    <Switch size="sm" checked={draft.autoHook} onCheckedChange={(autoHook) => set({ autoHook })} inputProps={{ "aria-label": "Add a hook to each clip" }} />
                  </Flex>
                </FieldGroup>

                <FieldGroup label="Finishing">
                  <FinishingFields idPrefix="recipe-finishing" draft={draft.finishing} onChange={(finishing) => set({ finishing })} available={finishingAvailable} queueAccounts={queueAccounts} />
                </FieldGroup>

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
            <Dialog.Footer px="6" py="4" gap="2">
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
