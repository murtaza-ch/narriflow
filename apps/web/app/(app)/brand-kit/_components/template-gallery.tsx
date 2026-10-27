"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Grid, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { Copy, Gem, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import type { BrandTemplateSummary, CaptionPreset } from "@narriflow/validators";
import { CaptionCue } from "../../projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import {
  deleteBrandTemplateAction,
  duplicateBrandTemplateAction,
  setDefaultBrandTemplateAction,
} from "../style-actions";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";
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
  access: TemplateGalleryAccess;
}

/** Server-action redirects surface as thrown NEXT_REDIRECT errors — rethrow. */
function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}

export function TemplateGallery({
  builtIns,
  mine,
  defaultId,
  access,
}: TemplateGalleryProps) {
  return (
    <Stack gap="8" role="radiogroup" aria-label="Default style">
      <Section
        title="Your styles"
        templates={mine}
        defaultId={defaultId}
        ownership="mine"
        access={access}
      />
      <Section
        title="Built-in"
        templates={builtIns}
        defaultId={defaultId}
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
  ownership: "mine" | "built-in";
  access: TemplateGalleryAccess;
}

function Section({ title, templates, defaultId, ownership, access }: SectionProps) {
  return (
    <Box as="section">
      <Text textStyle="eyebrow" color="fg.muted" mb="2">
        {title}
      </Text>
      <Box layerStyle="band">
        {templates.length === 0 ? (
          <EmptyState
            ratio={4 / 3}
            icon={<Plus size={18} />}
            title="No saved styles yet"
            description={access.canManage ? "Duplicate a built-in below to make it yours." : "Saved styles appear here."}
          />
        ) : (
          <Grid
            templateColumns={{
              base: "repeat(2, 1fr)",
              md: "repeat(3, 1fr)",
              lg: "repeat(4, 1fr)",
            }}
            gap="4"
          >
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isDefault={defaultId === template.id}
                ownership={ownership}
                access={access}
              />
            ))}
          </Grid>
        )}
      </Box>
    </Box>
  );
}

interface TemplateCardProps {
  template: BrandTemplateSummary;
  isDefault: boolean;
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

function TemplateCard({ template, isDefault, ownership, access }: TemplateCardProps) {
  const { openUpgrade } = useUpgrade();
  // A kept custom style on a plan without custom styles: editing and choosing it open the upgrade.
  const lockedCustom = ownership === "mine" ? access.customUpgrade : null;
  const canDuplicate = access.canManage && !(access.duplicateBlocked && !access.duplicateBlocked.upgrade);
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<
    "default" | "duplicate" | "delete" | null
  >(null);
  const { confirm, dialog } = useConfirm();

  function chooseDefault() {
    if (lockedCustom) {
      openUpgrade(lockedCustom);
      return;
    }
    handleSetDefault();
  }

  function handleSetDefault() {
    if (isDefault || pending) return;
    setPendingAction("default");
    startTransition(async () => {
      try {
        const result = await setDefaultBrandTemplateAction(template.id);
        if (isAuthenticatedActionFailure(result)) {
          toaster.create({
            type: "error",
            title: "Could not set default",
            description: authenticatedActionResultMessage(
              result,
              "The default style could not be changed.",
            ),
          });
          return;
        }
        toaster.create({
          type: "success",
          title: "Default style updated",
          description: `New projects will use "${template.name}".`,
        });
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        toaster.create({
          type: "error",
          title: "Could not set default",
          description: "Please try again.",
        });
      } finally {
        setPendingAction(null);
      }
    });
  }

  function handleDuplicate() {
    setPendingAction("duplicate");
    startTransition(async () => {
      try {
        const result = await duplicateBrandTemplateAction(template.id);
        if (isAuthenticatedActionFailure(result)) {
          toaster.create({
            type: "error",
            title: "Could not duplicate style",
            description: authenticatedActionResultMessage(
              result,
              "The style could not be duplicated.",
            ),
          });
          setPendingAction(null);
        }
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        setPendingAction(null);
        toaster.create({
          type: "error",
          title: "Could not duplicate style",
          description: "Please try again.",
        });
      }
    });
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: `Delete "${template.name}"?`,
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setPendingAction("delete");
    startTransition(async () => {
      try {
        const result = await deleteBrandTemplateAction(template.id);
        if (isAuthenticatedActionFailure(result)) {
          toaster.create({
            type: "error",
            title: "Could not delete style",
            description: authenticatedActionResultMessage(
              result,
              "The style could not be deleted.",
            ),
          });
          return;
        }
        toaster.create({ type: "success", title: "Style deleted" });
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        toaster.create({
          type: "error",
          title: "Could not delete style",
          description: "Please try again.",
        });
      } finally {
        setPendingAction(null);
      }
    });
  }

  const preset = template.captionPreset;

  return (
    <Stack gap="2" minW="0">
      {/* Compact type specimen; full video positioning is shown in the style editor. */}
      <MediaWell
        ratio={4 / 3}
        borderColor={isDefault ? "accent.solid" : "transparent"}
        borderWidth="2px"
        transition="border-color 120ms ease"
      >
        <CaptionSpecimen preset={preset} />
      </MediaWell>

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
          gap="1.5"
          minW="0"
          cursor={isDefault || !access.canSetDefault ? "default" : "pointer"}
          disabled={pending || !access.canSetDefault}
          onClick={chooseDefault}
          _disabled={{ cursor: pending ? "wait" : "default" }}
        >
          {pendingAction === "default" ? (
            <Spinner size="xs" />
          ) : (
            <Flex
              boxSize="3.5"
              align="center"
              justify="center"
              borderRadius="full"
              borderWidth="1px"
              borderColor={isDefault ? "accent.solid" : "border.control"}
              bg="bg.panel"
              flexShrink={0}
              transition="border-color 120ms ease"
            >
              {isDefault ? (
                <Box boxSize="1.5" borderRadius="full" bg="accent.solid" />
              ) : null}
            </Flex>
          )}
          <Text
            fontSize="13px"
            fontWeight={isDefault ? "600" : "500"}
            color="fg"
            truncate
            textAlign="left"
          >
            {template.name}
          </Text>
          {isDefault ? (
            <Text textStyle="eyebrow" color="accent.fg" flexShrink={0}>
              Default
            </Text>
          ) : null}
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

/** A static frame of the style's caption, drawn by the real caption engine. */
function CaptionSpecimen({ preset }: { preset: CaptionPreset }) {
  const [width, setWidth] = useState(0);
  return (
    <Flex
      ref={(element: HTMLDivElement | null) => {
        if (element && element.offsetWidth !== width) setWidth(element.offsetWidth);
      }}
      position="absolute"
      inset="0"
      align="center"
      justify="center"
    >
      {width > 0 && (
        <CaptionCue
          preset={preset}
          words={["This", "is", "your"].map((word, index) => ({ word, isActive: index === 2 }))}
          scale={(width * 1.6) / 1080}
          frameWidth={width}
          cueKey="specimen"
          reducedMotion
        />
      )}
    </Flex>
  );
}
