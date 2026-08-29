"use client";

import type { FormHTMLAttributes, ReactNode } from "react";
import { useActionState } from "react";
import { Text } from "@chakra-ui/react";
import {
  authenticatedRequestFailureMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

type AuthenticatedFormAction = (formData: FormData) => Promise<unknown>;

interface AuthenticatedActionFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "children"> {
  action: AuthenticatedFormAction;
  children: ReactNode;
  fallbackMessage?: string;
}

export function AuthenticatedActionForm({
  action,
  children,
  fallbackMessage = "The action could not be completed.",
  ...formProps
}: AuthenticatedActionFormProps) {
  const [failure, formAction] = useActionState(
    async (_previous: unknown, formData: FormData) => {
      const result = await action(formData);
      return isAuthenticatedActionFailure(result) ? result : null;
    },
    null,
  );

  return (
    <form {...formProps} action={formAction}>
      {children}
      {failure ? (
        <Text role="alert" fontSize="sm" color="danger.fg" mt="2">
          {authenticatedRequestFailureMessage(
            failure,
            window.location.pathname,
            fallbackMessage,
          )}
          {failure.requestId ? ` Support ID: ${failure.requestId}` : ""}
        </Text>
      ) : null}
    </form>
  );
}
