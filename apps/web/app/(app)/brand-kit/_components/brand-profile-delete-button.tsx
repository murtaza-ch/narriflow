"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect, Stack, Text } from "@chakra-ui/react";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { toaster } from "@narriflow/ui/components/toaster";
import { failureMessage, useBrandApi } from "./brand-api";

const NO_PROFILE = "";

/** What deleting a profile would move: it is the default, and the Recipes that name it. */
export interface BrandProfileUsage {
  isDefault: boolean;
  recipes: readonly { id: string; name: string }[];
}

/** "Default for new projects · Used by 2 Recipes: A, B", or null when nothing uses the profile. */
export function describeBrandProfileUsage(usage: BrandProfileUsage): string | null {
  const parts: string[] = [];
  if (usage.isDefault) parts.push("Default for new projects");
  if (usage.recipes.length > 0) {
    parts.push(`Used by ${usage.recipes.length} ${usage.recipes.length === 1 ? "Recipe" : "Recipes"}: ${usage.recipes.map((recipe) => recipe.name).join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Deleting stays possible on every plan and for the default. What used the
 * profile moves to the chosen replacement, or to no profile. */
export function BrandProfileDeleteButton({
  profileId,
  name,
  revision,
  usage,
  replacements,
}: {
  profileId: string;
  name: string;
  revision: number;
  usage: BrandProfileUsage;
  /** Other live profiles the plan can apply. */
  replacements: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { mutations, invalidate } = useBrandApi();
  const [open, setOpen] = useState(false);
  const [replacement, setReplacement] = useState(NO_PROFILE);
  const usageText = describeBrandProfileUsage(usage);

  const removal = useMutation({
    mutationFn: () =>
      mutations.deleteProfile(profileId, {
        revision,
        ...(usageText ? { replacementProfileId: replacement || null } : {}),
      }),
    onSuccess: () => {
      toaster.create({ type: "success", title: "Brand Profile deleted" });
      setOpen(false);
      // The button lives on the profile's own page, which no longer exists.
      router.replace("/brand-kit");
      void invalidate();
    },
    onError: (error) =>
      toaster.create({
        type: "error",
        title: "Could not delete the profile",
        description: failureMessage(error),
      }),
  });
  const pending = removal.isPending;

  return (
    <>
      <IconButton
        size="sm"
        variant="subtle"
        color="fg.muted"
        _hover={{ color: "danger.fg" }}
        aria-label={`Delete ${name}`}
        onClick={() => {
          setReplacement(NO_PROFILE);
          setOpen(true);
        }}
      >
        <Trash2 size={14} />
      </IconButton>
      <Dialog.Root
        open={open}
        onOpenChange={(details) => {
          if (!pending) setOpen(details.open);
        }}
        role="alertdialog"
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header pt="5" pb="0" px="5">
                <Dialog.Title textStyle="title" fontSize="15px" color="fg">{`Delete "${name}"?`}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body pt="2" pb="4" px="5">
                <Stack gap="4">
                  <Dialog.Description fontSize="13.5px" lineHeight="1.5" color="fg.muted">
                    {usageText ?? "It will no longer be offered for new projects."}
                  </Dialog.Description>
                  {usageText ? (
                    <Stack gap="2">
                      <Text asChild fontSize="12px" color="fg.muted">
                        <label htmlFor={`replace-${profileId}`}>Replace with</label>
                      </Text>
                      <NativeSelect.Root size="sm" disabled={pending}>
                        <NativeSelect.Field
                          id={`replace-${profileId}`}
                          value={replacement}
                          onChange={(event) => setReplacement(event.currentTarget.value)}
                          bg="bg.soft"
                          borderWidth="0"
                          borderRadius="l2"
                          _focusVisible={{ bg: "bg.muted", outline: "none" }}
                        >
                          <option value={NO_PROFILE}>No brand profile</option>
                          {replacements.map((profile) => (
                            <option key={profile.id} value={profile.id}>{profile.name}</option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                      <Text fontSize="12px" color="fg.muted">Existing projects keep their brand.</Text>
                    </Stack>
                  ) : null}
                </Stack>
              </Dialog.Body>
              <Dialog.Footer px="5" pb="4" pt="0" gap="2">
                <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="solid" size="sm" colorPalette="danger" loading={pending} onClick={() => removal.mutate()}>Delete</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
