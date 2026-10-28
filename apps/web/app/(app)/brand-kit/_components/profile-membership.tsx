"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { LayoutTemplate, Plus, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";

/** `PUT /brand-profiles/:id/membership`; throws the server's message on refusal. */
export async function putProfileMembership(
  profileId: string,
  body: { kind: "template" | "audio"; resourceId: string; position: number; remove?: true },
) {
  const response = await fetch(`/api/brand-profiles/${profileId}/membership`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "The profile could not be saved.");
  }
}

/** Runs a membership change with a busy flag and an error toast, then refreshes the page. */
export function useMembershipChange(title: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run(change: () => Promise<void>) {
    setBusy(true);
    try {
      await change();
      router.refresh();
    } catch (error) {
      toaster.create({ type: "error", title, description: error instanceof Error ? error.message : "Please try again." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
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
  const { busy, run } = useMembershipChange(`Could not remove ${label}`);
  return (
    <Button
      size="xs"
      variant="ghost"
      color="fg.muted"
      aria-label={`Remove ${label}`}
      disabled={busy}
      onClick={() => void run(() => putProfileMembership(profileId, { kind, resourceId, position: 0, remove: true }))}
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
  const { busy, run } = useMembershipChange("Could not add the style");
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
                    onClick={() => void run(() => putProfileMembership(profileId, { kind: "template", resourceId: style.id, position: nextPosition }))}
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
