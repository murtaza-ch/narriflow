"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect, Stack, Text } from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import type { BrandProfileUsage } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { toaster } from "@narriflow/ui/components/toaster";

const NO_PROFILE = "";

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
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [replacement, setReplacement] = useState(NO_PROFILE);
  const usageText = describeBrandProfileUsage(usage);

  function remove() {
    startTransition(async () => {
      try {
        const response = await fetch(`/api/brand-profiles/${profileId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision, ...(usageText ? { replacementProfileId: replacement || null } : {}) }),
        });
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) throw new Error(payload?.message ?? "The profile could not be deleted.");
        toaster.create({ type: "success", title: "Brand Profile deleted" });
        setOpen(false);
        router.refresh();
      } catch (error) {
        toaster.create({
          type: "error",
          title: "Could not delete the profile",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        color="fg.muted"
        aria-label={`Delete ${name}`}
        onClick={() => {
          setReplacement(NO_PROFILE);
          setOpen(true);
        }}
      >
        <Trash2 size={12} />
      </Button>
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
                <Button variant="solid" size="sm" colorPalette="danger" loading={pending} onClick={remove}>Delete</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
