"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect } from "@chakra-ui/react";
import { X } from "lucide-react";
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

/** Picks one of the owner's styles that no profile uses yet. */
export function StyleAdder({
  profileId,
  styles,
  nextPosition,
}: {
  profileId: string;
  styles: { id: string; name: string }[];
  nextPosition: number;
}) {
  const { busy, run } = useMembershipChange("Could not add the style");
  return (
    <NativeSelect.Root size="sm" w="auto" minW="44" disabled={busy}>
      <NativeSelect.Field
        aria-label="Add style"
        value=""
        onChange={(event) => {
          const resourceId = event.currentTarget.value;
          if (resourceId) void run(() => putProfileMembership(profileId, { kind: "template", resourceId, position: nextPosition }));
        }}
        bg="bg.soft"
        borderWidth="0"
        borderRadius="l2"
        _focusVisible={{ bg: "bg.muted", outline: "none" }}
      >
        <option value="">Add style</option>
        {styles.map((style) => (
          <option key={style.id} value={style.id}>{style.name}</option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}
