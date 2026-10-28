"use client";

import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import { failureMessage, useBrandApi } from "./brand-api";

export function BrandProfileDefaultButton({ profileId }: { profileId: string }) {
  const { mutations, invalidate } = useBrandApi();
  const setDefault = useMutation({
    mutationFn: () => mutations.setDefaultProfile(profileId),
    onSuccess: async () => {
      toaster.create({ type: "success", title: "Default Brand Profile updated" });
      await invalidate();
    },
    onError: (error) =>
      toaster.create({
        type: "error",
        title: "Could not update the default profile",
        description: failureMessage(error),
      }),
  });

  return (
    <Button size="sm" variant="subtle" onClick={() => setDefault.mutate()} loading={setDefault.isPending}>
      <Check size={13} />
      Make default
    </Button>
  );
}
