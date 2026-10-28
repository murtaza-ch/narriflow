"use client";

import { useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Menu, Portal, Spinner, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, ChevronDown, Palette, Settings2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import { BrandMark } from "../../brand-kit/_components/brand-kit-ui";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { applyProjectBrandProfileFormAction } from "../actions";

export interface BrandChoice {
  id: string;
  name: string;
  colors: { primaryColor: string; secondaryColor: string; accentColor: string | null };
  logoUrl: string | null;
}

/**
 * The Project's Brand Profile at a glance — its mark and name — with a
 * one-step switch. Picking a brand applies it; there is no separate Apply.
 */
export function ProjectBrandPicker({
  projectId,
  brands,
  currentBrandId,
  canEdit,
  upgrade,
  requirementMessage,
}: {
  projectId: string;
  brands: BrandChoice[];
  currentBrandId: string | null;
  canEdit: boolean;
  /** Set when a plan upgrade would allow applying a brand. */
  upgrade: UpgradePrompt | null;
  /** Why applying is unavailable when no upgrade clears it. */
  requirementMessage: string | null;
}) {
  const [selectedId, setOptimisticId] = useOptimistic(currentBrandId);
  const [pending, startApplying] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = brands.find((brand) => brand.id === selectedId) ?? null;

  function apply(profileId: string) {
    if (profileId === selectedId) return;
    setError(null);
    startApplying(async () => {
      setOptimisticId(profileId);
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("profileId", profileId);
      try {
        const result = await applyProjectBrandProfileFormAction(formData);
        if (isAuthenticatedActionFailure(result)) {
          setError(authenticatedActionResultMessage(result, "Could not apply this brand."));
        }
      } catch {
        setError("Could not apply this brand.");
      }
    });
  }

  const triggerLabel = current ? "Change brand" : "Choose brand";
  const action = !canEdit ? null : upgrade ? (
    <LockedButton type="button" size="sm" variant="subtle" prompt={upgrade}>
      {triggerLabel}
    </LockedButton>
  ) : requirementMessage ? (
    <Text fontSize="13px" color="fg.muted" maxW="36ch" textAlign={{ md: "end" }}>
      {requirementMessage}
    </Text>
  ) : (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button type="button" size="sm" variant="subtle" disabled={pending}>
          {pending ? <Spinner size="xs" /> : null}
          {pending ? "Applying…" : triggerLabel}
          {pending ? null : <ChevronDown size={14} aria-hidden />}
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="280px" aria-label="Brand profiles">
            <Menu.RadioItemGroup
              value={selectedId ?? ""}
              onValueChange={(details) => apply(details.value)}
            >
              {brands.map((brand) => (
                <Menu.RadioItem key={brand.id} value={brand.id} h="12" gap="3">
                  <BrandMark colors={brand.colors} logoUrl={brand.logoUrl} name={brand.name} size={28} />
                  <Menu.ItemText flex="1" truncate>
                    {brand.name}
                  </Menu.ItemText>
                  <Menu.ItemIndicator color="accent.fg">
                    <Check size={14} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioItemGroup>
            <Menu.Separator />
            <Menu.Item value="manage" asChild color="fg.muted">
              <Link href="/brand-kit">
                <Settings2 size={14} aria-hidden />
                Manage brand kit
              </Link>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );

  return (
    <Box>
      <Flex
        align={{ base: "stretch", md: "center" }}
        direction={{ base: "column", md: "row" }}
        justify="space-between"
        gap="4"
        p="4"
        bg="bg.panel"
        borderRadius="l3"
        borderWidth="1px"
        borderColor="border.card"
      >
        <Flex align="center" gap="3.5" minW="0">
          {current ? (
            <BrandMark colors={current.colors} logoUrl={current.logoUrl} name={current.name} size={44} />
          ) : (
            <Flex boxSize="44px" flexShrink={0} align="center" justify="center" borderRadius="10px" bg="bg.soft" color="fg.muted">
              <Palette size={18} aria-hidden />
            </Flex>
          )}
          <Box minW="0">
            <Text fontSize="15px" fontWeight="500" color="fg" truncate>
              {current?.name ?? "No brand"}
            </Text>
            <Text fontSize="13px" color="fg.muted" mt="0.5">
              {current ? "Styles new clips" : "Pick a brand to style new clips"}
            </Text>
          </Box>
        </Flex>
        {action}
      </Flex>
      {error ? (
        <Flex align="center" gap="1.5" color="danger.fg" mt="2">
          <AlertTriangle size={12} aria-hidden />
          <Text fontSize="xs">{error}</Text>
        </Flex>
      ) : null}
    </Box>
  );
}
