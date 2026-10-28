"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Box, Flex, Grid, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { Check, Copy, Gem, LayoutTemplate, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import type { BrandTemplateSummary } from "@narriflow/validators";
import { CoverChip } from "./brand-kit-ui";
import { StyleThumb } from "../../_shared/style-thumb";
import { failureMessage, useBrandApi, useIntent } from "./brand-api";
import { useUpgrade, type UpgradePrompt } from "../../_components/upgrade";

/**
 * What this member may do with styles, mirroring brand-template.service.ts:
 * editing needs `brand.manage`, choosing the default needs `workspace.manage`,
 * and the plan gates custom styles and their count.
 */
export interface TemplateGalleryAccess {
  canManage: boolean;
  canSetDefault: boolean;
  /** The plan that unlocks custom styles when this one lacks them (edit or default a kept style). */
  customUpgrade: UpgradePrompt | null;
  /** Why another style can't be saved: an upgrade when a plan lifts it, else `null` (the page explains). */
  duplicateBlocked: { upgrade: UpgradePrompt | null } | null;
}

interface TemplateGalleryProps {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  defaultId: string | null;
  /** The Brand Profile each style belongs to, by style id. */
  profileByStyle?: Record<string, string>;
  access: TemplateGalleryAccess;
}

export function TemplateGallery({
  builtIns,
  mine,
  defaultId,
  profileByStyle = {},
  access,
}: TemplateGalleryProps) {
  return (
    <Stack gap="10" role="radiogroup" aria-label="Default style">
      <Section
        title="Your styles"
        templates={mine}
        defaultId={defaultId}
        profileByStyle={profileByStyle}
        ownership="mine"
        access={access}
      />
      <Section
        title="Built-in"
        templates={builtIns}
        defaultId={defaultId}
        profileByStyle={profileByStyle}
        ownership="built-in"
        access={access}
      />
    </Stack>
  );
}

interface SectionProps {
  title: string;
  templates: BrandTemplateSummary[];
  defaultId: string | null;
  profileByStyle: Record<string, string>;
  ownership: "mine" | "built-in";
  access: TemplateGalleryAccess;
}

/** Thumbnails share one grid so built-ins and saved styles line up. */
export const STYLE_GRID_COLUMNS = { base: "repeat(2, minmax(0, 1fr))", sm: "repeat(3, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))", lg: "repeat(5, minmax(0, 1fr))", xl: "repeat(6, minmax(0, 1fr))" };

function Section({ title, templates, defaultId, profileByStyle, ownership, access }: SectionProps) {
  return (
    <Stack as="section" gap="4">
      <Flex align="baseline" gap="2">
        <Text as="h2" fontSize="15px" fontWeight="500">
          {title}
        </Text>
        {templates.length > 0 ? (
          <Text fontSize="13px" color="fg.subtle" fontVariantNumeric="tabular-nums">
            {templates.length}
          </Text>
        ) : null}
      </Flex>
      {templates.length === 0 ? (
        <EmptyState
          icon={<LayoutTemplate size={18} />}
          title="No saved styles yet"
          description={access.canManage ? "Duplicate a built-in below to make it yours." : "Saved styles appear here."}
        />
      ) : (
        <Grid templateColumns={STYLE_GRID_COLUMNS} gap="4" rowGap="5">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isDefault={defaultId === template.id}
              profileName={profileByStyle[template.id] ?? null}
              ownership={ownership}
              access={access}
            />
          ))}
        </Grid>
      )}
    </Stack>
  );
}

interface TemplateCardProps {
  template: BrandTemplateSummary;
  isDefault: boolean;
  profileName: string | null;
  ownership: "mine" | "built-in";
  access: TemplateGalleryAccess;
}

function UpgradeMark() {
  return (
    <Box as="span" ms="auto" color="upgrade.fg" display="inline-flex">
      <Gem size={12} aria-hidden />
    </Box>
  );
}

function TemplateCard({ template, isDefault, profileName, ownership, access }: TemplateCardProps) {
  const { openUpgrade } = useUpgrade();
  // A kept custom style on a plan without custom styles: editing and choosing it open the upgrade.
  const lockedCustom = ownership === "mine" ? access.customUpgrade : null;
  const canDuplicate = access.canManage && !(access.duplicateBlocked && !access.duplicateBlocked.upgrade);
  const router = useRouter();
  const { mutations, invalidate } = useBrandApi();
  const duplicateIntent = useIntent<{ id: string }>();
  // The new style's editor opens once it exists; the card stays busy until then.
  const [opening, setOpening] = useState(false);
  const { confirm, dialog } = useConfirm();

  const setDefault = useMutation({
    mutationFn: () => mutations.setDefaultTemplate(template.id),
    onSuccess: async () => {
      toaster.create({
        type: "success",
        title: "Default style updated",
        description: `New projects will use "${template.name}".`,
      });
      await invalidate();
    },
    onError: (error) =>
      toaster.create({ type: "error", title: "Could not set default", description: failureMessage(error, "The default style could not be changed.") }),
  });
  const duplicate = useMutation({
    mutationFn: () => mutations.duplicateTemplate(template.id, {}, duplicateIntent.keyFor({ id: template.id })),
    onSuccess: (created) => {
      duplicateIntent.complete();
      setOpening(true);
      router.push(`/brand-kit/styles/${created.id}`);
      void invalidate();
    },
    onError: (error) =>
      toaster.create({ type: "error", title: "Could not duplicate style", description: failureMessage(error, "The style could not be duplicated.") }),
  });
  const remove = useMutation({
    mutationFn: () => mutations.deleteTemplate(template.id),
    onSuccess: async () => {
      toaster.create({ type: "success", title: "Style deleted" });
      await invalidate();
    },
    onError: (error) =>
      toaster.create({ type: "error", title: "Could not delete style", description: failureMessage(error, "The style could not be deleted.") }),
  });
  const pending = setDefault.isPending || duplicate.isPending || remove.isPending || opening;
  const pendingAction = setDefault.isPending ? "default" : duplicate.isPending || opening ? "duplicate" : remove.isPending ? "delete" : null;

  function chooseDefault() {
    if (lockedCustom) {
      openUpgrade(lockedCustom);
      return;
    }
    handleSetDefault();
  }

  function handleSetDefault() {
    if (isDefault || pending) return;
    setDefault.mutate();
  }

  function handleDuplicate() {
    duplicate.mutate();
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: `Delete "${template.name}"?`,
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    remove.mutate();
  }

  const preset = template.captionPreset;
  const editHref = access.canManage && ownership === "mine" && !lockedCustom ? `/brand-kit/styles/${template.id}` : null;
  const thumb = (
    <Box
      position="relative"
      borderRadius="l2"
      overflow="hidden"
      outline="2px solid"
      outlineColor={isDefault ? "accent.solid" : "transparent"}
      outlineOffset="2px"
      transition="outline-color 150ms ease"
    >
      <Box transition="transform 400ms cubic-bezier(0.22, 1, 0.36, 1)" _groupHover={{ transform: "scale(1.04)" }}>
        <StyleThumb preset={preset} seed={template.id} imageSizes="(min-width: 1280px) 18vw, (min-width: 768px) 24vw, 45vw" />
      </Box>
      <Stack position="absolute" top="2" left="2" right="2" gap="1.5" align="flex-start" pointerEvents="none">
        {isDefault ? <CoverChip icon={<Check size={12} />}>Default</CoverChip> : null}
        {profileName ? <CoverChip>{profileName}</CoverChip> : null}
      </Stack>
    </Box>
  );

  return (
    <Stack gap="2.5" minW="0" className="group">
      {editHref ? (
        <Link href={editHref} aria-label={`Edit ${template.name}`}>
          {thumb}
        </Link>
      ) : thumb}

      <Flex align="center" justify="space-between" gap="1" minW="0">
        {/* Default selection — radio pattern with pending indication. Only
            members who may choose the default get a control; others see the mark. */}
        <chakra.button
          type="button"
          role="radio"
          aria-checked={isDefault}
          aria-label={`Use "${template.name}" as default style`}
          display="inline-flex"
          alignItems="center"
          gap="2"
          minW="0"
          cursor={isDefault || !access.canSetDefault ? "default" : "pointer"}
          disabled={pending || !access.canSetDefault}
          onClick={chooseDefault}
          _disabled={{ cursor: pending ? "wait" : "default" }}
        >
          {pendingAction === "default" ? (
            <Spinner size="xs" />
          ) : access.canSetDefault || isDefault ? (
            <Flex
              boxSize="3.5"
              align="center"
              justify="center"
              borderRadius="full"
              borderWidth="1.5px"
              borderColor={isDefault ? "accent.solid" : "border.emphasized"}
              flexShrink={0}
              transition="border-color 120ms ease"
              _groupHover={isDefault ? undefined : { borderColor: "border.control" }}
            >
              {isDefault ? (
                <Box boxSize="1.5" borderRadius="full" bg="accent.solid" />
              ) : null}
            </Flex>
          ) : null}
          <Text
            fontSize="13px"
            fontWeight="500"
            color="fg"
            truncate
            textAlign="left"
          >
            {template.name}
          </Text>
        </chakra.button>
        {access.canManage || access.canSetDefault ? (
        <Menu.Root positioning={{ placement: "bottom-end", gutter: 4 }}>
          <Menu.Trigger asChild>
            <IconButton
              size="xs"
              variant="ghost"
              colorPalette="gray"
              aria-label={`Actions for ${template.name}`}
              disabled={pending}
            >
              <MoreVertical size={14} />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content>
                {!isDefault && access.canSetDefault ? (
                  <Menu.Item
                    value="set-default"
                    onClick={chooseDefault}
                  >
                    <Box boxSize="3" borderRadius="full" borderWidth="1px" borderColor="border.control" />
                    Set as default
                    {lockedCustom ? <UpgradeMark /> : null}
                  </Menu.Item>
                ) : null}
                {access.canManage ? (
                  <Menu.Item
                    value="duplicate"
                    disabled={!canDuplicate}
                    onClick={() => (access.duplicateBlocked?.upgrade ? openUpgrade(access.duplicateBlocked.upgrade) : handleDuplicate())}
                  >
                    {pendingAction === "duplicate" ? (
                      <Spinner size="xs" />
                    ) : (
                      <Copy size={13} />
                    )}
                    Duplicate
                    {access.duplicateBlocked?.upgrade ? <UpgradeMark /> : null}
                  </Menu.Item>
                ) : null}
                {access.canManage && ownership === "mine" ? (
                  lockedCustom ? (
                    <Menu.Item value="edit" onClick={() => openUpgrade(lockedCustom)}>
                      <Pencil size={13} />
                      Edit
                      <UpgradeMark />
                    </Menu.Item>
                  ) : (
                    <Menu.Item value="edit" asChild>
                      <Link href={`/brand-kit/styles/${template.id}`}>
                        <Pencil size={13} />
                        Edit
                      </Link>
                    </Menu.Item>
                  )
                ) : null}
                {access.canManage && ownership === "mine" ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item
                      value="delete"
                      color="danger.fg"
                      onClick={() => void handleDelete()}
                    >
                      <Trash2 size={13} />
                      Delete
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
        ) : null}
      </Flex>
      {dialog}
    </Stack>
  );
}
