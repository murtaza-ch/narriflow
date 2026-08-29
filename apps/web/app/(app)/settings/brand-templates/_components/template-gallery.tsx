"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Grid, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { Copy, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import type { BrandTemplateSummary } from "@narriflow/validators";
import {
  deleteBrandTemplateAction,
  duplicateBrandTemplateAction,
  setDefaultBrandTemplateAction,
} from "../actions";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

interface TemplateGalleryProps {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  defaultId: string | null;
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
}: TemplateGalleryProps) {
  return (
    <Stack gap="8" role="radiogroup" aria-label="Default template">
      <Section
        title="Your templates"
        templates={mine}
        defaultId={defaultId}
        ownership="mine"
      />
      <Section
        title="Built-in"
        templates={builtIns}
        defaultId={defaultId}
        ownership="built-in"
      />
    </Stack>
  );
}

interface SectionProps {
  title: string;
  templates: BrandTemplateSummary[];
  defaultId: string | null;
  ownership: "mine" | "built-in";
}

function Section({ title, templates, defaultId, ownership }: SectionProps) {
  return (
    <Box as="section">
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        {title}
      </Text>
      <Box layerStyle="band">
        {templates.length === 0 ? (
          <EmptyState
            ratio={9 / 16}
            icon={<Plus size={18} />}
            title="No saved templates yet"
            description="Duplicate a built-in below to make it yours."
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
}

function TemplateCard({ template, isDefault, ownership }: TemplateCardProps) {
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<
    "default" | "duplicate" | "delete" | null
  >(null);
  const { confirm, dialog } = useConfirm();

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
              "The default template could not be changed.",
            ),
          });
          return;
        }
        toaster.create({
          type: "success",
          title: "Default template updated",
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
            title: "Could not duplicate template",
            description: authenticatedActionResultMessage(
              result,
              "The template could not be duplicated.",
            ),
          });
          setPendingAction(null);
        }
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        setPendingAction(null);
        toaster.create({
          type: "error",
          title: "Could not duplicate template",
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
            title: "Could not delete template",
            description: authenticatedActionResultMessage(
              result,
              "The template could not be deleted.",
            ),
          });
          return;
        }
        toaster.create({ type: "success", title: "Template deleted" });
      } catch (error) {
        if (isNextRedirect(error)) throw error;
        toaster.create({
          type: "error",
          title: "Could not delete template",
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
      {/* Real 9:16 preview — footage ground, caption specimen in user style.
          Default = selected object: accent border (label carries the state). */}
      <MediaWell
        ratio={9 / 16}
        borderColor={isDefault ? "border.accent" : "border"}
        borderWidth={isDefault ? "2px" : "1px"}
        transition="border-color 120ms ease"
      >
        {/* Brand-color tint over graphite — user color values stay literal */}
        <Box
          position="absolute"
          inset="0"
          style={{
            background: `linear-gradient(135deg, ${template.primaryColor}26 0%, ${template.secondaryColor}26 100%)`,
          }}
        />
        <Flex
          position="absolute"
          inset="0"
          px="3"
          py="6"
          align={
            preset.position === "top"
              ? "flex-start"
              : preset.position === "center"
                ? "center"
                : "flex-end"
          }
          justify="center"
        >
          <Text
            fontSize="15px"
            fontWeight={preset.bold ? 800 : 500}
            textAlign="center"
            lineHeight="1.15"
            style={{
              // User caption styling — values intentionally literal.
              fontFamily: preset.fontName,
              color: preset.primaryColor,
              letterSpacing: `${preset.letterSpacing ?? 0}em`,
              textTransform: preset.textTransform ?? "none",
              textShadow:
                preset.shadow === 1
                  ? "0 2px 8px rgba(14, 16, 19, 0.65)"
                  : "none",
              WebkitTextStroke:
                preset.outlineWidth > 0
                  ? `${Math.min(1, preset.outlineWidth * 0.4)}px ${preset.outlineColor}`
                  : undefined,
            }}
          >
            This is{" "}
            <span style={{ color: preset.highlightColor }}>your</span> brand
          </Text>
        </Flex>
      </MediaWell>

      <Flex align="center" justify="space-between" gap="1" minW="0">
        {/* Default selection — radio pattern with pending indication */}
        <chakra.button
          type="button"
          role="radio"
          aria-checked={isDefault}
          aria-label={`Use "${template.name}" as default template`}
          display="inline-flex"
          alignItems="center"
          gap="1.5"
          minW="0"
          cursor={isDefault ? "default" : "pointer"}
          disabled={pending}
          onClick={handleSetDefault}
          _disabled={{ cursor: "wait" }}
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
              <Menu.Content layerStyle="panel" boxShadow="cardHover" minW="10rem" p="1">
                {!isDefault ? (
                  <Menu.Item
                    value="set-default"
                    fontSize="13px"
                    gap="2"
                    borderRadius="l1"
                    onClick={handleSetDefault}
                  >
                    <Box boxSize="3" borderRadius="full" borderWidth="1px" borderColor="border.control" />
                    Set as default
                  </Menu.Item>
                ) : null}
                <Menu.Item
                  value="duplicate"
                  fontSize="13px"
                  gap="2"
                  borderRadius="l1"
                  onClick={handleDuplicate}
                >
                  {pendingAction === "duplicate" ? (
                    <Spinner size="xs" />
                  ) : (
                    <Copy size={13} />
                  )}
                  Duplicate
                </Menu.Item>
                {ownership === "mine" ? (
                  <Menu.Item value="edit" fontSize="13px" gap="2" borderRadius="l1" asChild>
                    <Link href={`/brand-kit/${template.id}`}>
                      <Pencil size={13} />
                      Edit
                    </Link>
                  </Menu.Item>
                ) : null}
                {ownership === "mine" ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item
                      value="delete"
                      fontSize="13px"
                      gap="2"
                      borderRadius="l1"
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
      </Flex>
      {dialog}
    </Stack>
  );
}
