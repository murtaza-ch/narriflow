"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { Box, Flex, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { LayoutTemplate, Plus, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import type { BrandProfileMembership } from "@narriflow/api-client/brand";
import { failureMessage, useBrandApi } from "./brand-api";

/**
 * Runs a membership change with a busy flag and an error toast. A confirmed
 * change refreshes the profile and everything that lists it. `put` is
 * `PUT /brand-profiles/:id/membership`; it throws the server's message on refusal.
 */
export function useMembershipChange(title: string) {
  const { mutations, invalidate } = useBrandApi();
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => invalidate(),
    onError: (error) => toaster.create({ type: "error", title, description: failureMessage(error) }),
  });
  const put = (profileId: string, body: BrandProfileMembership) => mutations.setProfileMembership(profileId, body);
  return {
    busy: change.isPending,
    run: (run: () => Promise<unknown>) => change.mutateAsync(run).then(
      () => true,
      () => false,
    ),
    put,
  };
}

export function MembershipRemoveButton({
  profileId,
  kind,
  resourceId,
  label,
}: {
  profileId: string;
  kind: "template" | "audio";
  resourceId: string;
  label: string;
}) {
  const { busy, run, put } = useMembershipChange(`Could not remove ${label}`);
  return (
    <Button
      size="xs"
      variant="ghost"
      color="fg.muted"
      aria-label={`Remove ${label}`}
      disabled={busy}
      onClick={() => void run(() => put(profileId, { kind, resourceId, position: 0, remove: true }))}
    >
      <X size={13} />
    </Button>
  );
}

/**
 * The "Add style" tile at the end of a profile's styles: a menu of the
 * owner's styles no profile uses yet, and the way to make a new one.
 */
export function StyleAdder({
  profileId,
  styles,
  nextPosition,
  createHref,
  variant = "tile",
}: {
  profileId: string;
  styles: { id: string; name: string }[];
  nextPosition: number;
  /** Where a new style is made; omitted when the viewer can't make one. */
  createHref?: string;
  /** `tile` ends a grid of thumbnails; `button` sits in an empty state. */
  variant?: "tile" | "button";
}) {
  const { busy, run, put } = useMembershipChange("Could not add the style");
  return (
    <Menu.Root positioning={{ placement: variant === "tile" ? "bottom-start" : "bottom", gutter: 6 }}>
      <Menu.Trigger asChild>
        {variant === "tile" ? (
          <chakra.button type="button" aria-label="Add style" disabled={busy} w="full" textAlign="left" cursor="pointer" className="group">
            <AddTile label="Add style" />
          </chakra.button>
        ) : (
          <Button size="sm" variant="subtle" loading={busy}>
            <Plus size={14} /> Add style
          </Button>
        )}
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content maxH="320px" overflowY="auto">
            {styles.length > 0 ? (
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel>Your styles</Menu.ItemGroupLabel>
                {styles.map((style) => (
                  <Menu.Item
                    key={style.id}
                    value={style.id}
                    onClick={() => void run(() => put(profileId, { kind: "template", resourceId: style.id, position: nextPosition }))}
                  >
                    <LayoutTemplate size={14} />
                    <Text truncate>{style.name}</Text>
                  </Menu.Item>
                ))}
              </Menu.ItemGroup>
            ) : (
              <Text px="2.5" py="2" fontSize="13px" color="fg.muted">
                Every style is already in a profile.
              </Text>
            )}
            {createHref ? (
              <>
                <Menu.Separator />
                <Menu.Item value="create" asChild>
                  <Link href={createHref}>
                    <Plus size={14} /> Create a new style
                  </Link>
                </Menu.Item>
              </>
            ) : null}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** A soft 9:16 tile that starts something new in a grid of thumbnails. */
export function AddTile({ label, icon = <Plus size={18} /> }: { label: string; icon?: React.ReactNode }) {
  return (
    <Stack gap="2.5">
      <Flex
        aspectRatio={9 / 16}
        direction="column"
        align="center"
        justify="center"
        gap="3"
        borderRadius="l2"
        bg="bg.soft"
        color="fg.muted"
        transition="background 120ms ease, color 120ms ease"
        _groupHover={{ bg: "bg.softHover", color: "fg" }}
      >
        <Flex boxSize="11" borderRadius="full" bg="bg.soft" align="center" justify="center">
          {icon}
        </Flex>
        <Text fontSize="13px" fontWeight="500">
          {label}
        </Text>
      </Flex>
      <Box h="6" />
    </Stack>
  );
}
