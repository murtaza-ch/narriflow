"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";

export function BrandProfileDefaultButton({ profileId }: { profileId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function setDefault() {
    startTransition(async () => {
      try {
        const response = await fetch(`/api/brand-profiles/${profileId}/set-default`, {
          method: "POST",
        });
        const payload = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        if (!response.ok) {
          throw new Error(payload?.message ?? "The default profile could not be changed.");
        }
        toaster.create({ type: "success", title: "Default Brand Profile updated" });
        router.refresh();
      } catch (error) {
        toaster.create({
          type: "error",
          title: "Could not update the default profile",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    });
  }

  return (
    <Button size="xs" variant="ghost" onClick={setDefault} disabled={pending}>
      <Check size={12} />
      {pending ? "Updating…" : "Make default"}
    </Button>
  );
}
