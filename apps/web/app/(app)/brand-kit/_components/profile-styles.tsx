"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Box, Flex, Grid, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { Check, MoreVertical, Pencil, Star, X } from "lucide-react";
import type { CaptionPreset } from "@narriflow/validators";
import { IconButton } from "@narriflow/ui/components/button";
import { CoverChip } from "./brand-kit-ui";
import { StyleThumb } from "../../_shared/style-thumb";
import { STYLE_GRID_COLUMNS } from "./template-gallery";
import { putProfileMembership, useMembershipChange } from "./profile-membership";
import { useProfilePatch } from "./profile-editor";

export interface ProfileStyle {
  id: string;
  name: string;
  preset: CaptionPreset | null;
}

/** The profile's caption styles as live thumbnails; the default is what new projects with this profile use. */
export function ProfileStyleGrid({
  profileId,
  styles,
  defaultId,
  highlightId,
  canSetDefault,
  canRemove,
  adder,
}: {
  profileId: string;
  styles: ProfileStyle[];
  defaultId: string | null;
  /** The style just edited, when returning from the style editor. */
  highlightId?: string;
  canSetDefault: boolean;
  canRemove: boolean;
  /** The trailing tile: add a style, or the upgrade that allows it. */
  adder: ReactNode;
}) {
  return (
    <Grid templateColumns={STYLE_GRID_COLUMNS} gap="4" rowGap="5">
      {styles.map((style) => (
        <ProfileStyleCard
          key={style.id}
          profileId={profileId}
          style={style}
          isDefault={style.id === defaultId}
          highlighted={style.id === highlightId}
          canSetDefault={canSetDefault}
          canRemove={canRemove}
        />
      ))}
      {adder}
    </Grid>
  );
}

function ProfileStyleCard({ profileId, style, isDefault, highlighted, canSetDefault, canRemove }: { profileId: string; style: ProfileStyle; isDefault: boolean; highlighted: boolean; canSetDefault: boolean; canRemove: boolean }) {
  const patch = useProfilePatch();
  const [pending, setPending] = useState(false);
  const { busy, run } = useMembershipChange(`Could not remove ${style.name}`);
  const editHref = `/brand-kit/styles/${style.id}`;
  async function makeDefault() {
    setPending(true);
    await patch({ defaultTemplateId: style.id }, `New projects with this profile use "${style.name}"`);
    setPending(false);
  }
  return (
    <Stack gap="2.5" minW="0" className="group">
      <Link href={editHref} aria-label={`Edit ${style.name}`}>
        <Box
          position="relative"
          borderRadius="l2"
          overflow="hidden"
          outline="2px solid"
          outlineColor={highlighted ? "accent.solid" : "transparent"}
          outlineOffset="2px"
        >
          <Box transition="transform 400ms cubic-bezier(0.22, 1, 0.36, 1)" _groupHover={{ transform: "scale(1.04)" }}>
            {style.preset ? (
              <StyleThumb preset={style.preset} seed={style.id} imageSizes="(min-width: 1280px) 18vw, (min-width: 768px) 24vw, 45vw" />
            ) : (
              <Box aspectRatio={9 / 16} bg="studio.subtle" />
            )}
          </Box>
          {isDefault ? (
            <Box position="absolute" top="2" left="2" pointerEvents="none">
              <CoverChip icon={<Check size={12} />}>Default</CoverChip>
            </Box>
          ) : null}
        </Box>
      </Link>
      <Flex align="center" justify="space-between" gap="1" minW="0" h="6">
        <Text fontSize="13px" fontWeight="500" truncate>
          {style.name}
        </Text>
        <Menu.Root positioning={{ placement: "bottom-end", gutter: 4 }}>
          <Menu.Trigger asChild>
            <IconButton size="xs" variant="ghost" aria-label={`Actions for ${style.name}`} disabled={pending || busy}>
              <MoreVertical size={14} />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content>
                {canSetDefault && !isDefault ? (
                  <Menu.Item value="default" onClick={() => void makeDefault()}>
                    <Star size={14} /> Make default
                  </Menu.Item>
                ) : null}
                <Menu.Item value="edit" asChild>
                  <Link href={editHref}>
                    <Pencil size={14} /> Edit style
                  </Link>
                </Menu.Item>
                {canRemove ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item
                      value="remove"
                      onClick={() => void run(() => putProfileMembership(profileId, { kind: "template", resourceId: style.id, position: 0, remove: true }))}
                    >
                      <X size={14} /> Remove from profile
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </Flex>
    </Stack>
  );
}
