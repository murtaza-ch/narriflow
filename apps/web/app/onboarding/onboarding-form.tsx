"use client";

import { useFormStatus } from "react-dom";
import { SimpleGrid, Stack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Spinner } from "@narriflow/ui/components/spinner";
import { completeOnboardingAction } from "../actions/onboarding";
import { AuthenticatedActionForm } from "../_components/authenticated-action-form";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" w="full" disabled={pending}>
      {pending ? (
        <>
          <Spinner size="xs" borderTopColor="accent.contrast" />
          Setting up…
        </>
      ) : (
        "Enter your workspace"
      )}
    </Button>
  );
}

interface OnboardingFormProps {
  defaultFirstName: string;
  defaultLastName: string;
}

/**
 * Collects the name fields that sign-up no longer asks for (optional,
 * prefilled for OAuth users) and completes onboarding via the server action.
 */
export function OnboardingForm({ defaultFirstName, defaultLastName }: OnboardingFormProps) {
  return (
    <AuthenticatedActionForm action={completeOnboardingAction}>
      <Stack gap="4">
        <SimpleGrid columns={{ base: 1, sm: 2 }} gap="4">
          <Stack gap="1.5">
            <Label htmlFor="firstName" fontSize="13px" fontWeight="500">
              First name
            </Label>
            <Input
              autoComplete="given-name"
              defaultValue={defaultFirstName}
              id="firstName"
              name="firstName"
              placeholder="Optional"
              type="text"
            />
          </Stack>
          <Stack gap="1.5">
            <Label htmlFor="lastName" fontSize="13px" fontWeight="500">
              Last name
            </Label>
            <Input
              autoComplete="family-name"
              defaultValue={defaultLastName}
              id="lastName"
              name="lastName"
              placeholder="Optional"
              type="text"
            />
          </Stack>
        </SimpleGrid>
        <SubmitButton />
      </Stack>
    </AuthenticatedActionForm>
  );
}
