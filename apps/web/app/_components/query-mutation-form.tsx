"use client";

import { Stack, Text } from "@chakra-ui/react";
import { describeApiFailure, isApiError } from "@narriflow/api-client";
import { Button } from "@narriflow/ui/components/button";
import type { UseMutationResult } from "@tanstack/react-query";
import type { FormEvent, FormHTMLAttributes, ReactNode } from "react";
import {
  authenticatedRequestFailureMessage,
  type BrowserRequestFailure,
} from "@/lib/authenticated-request-browser";

/** An API failure in the shape the shared recovery wording reads. */
function browserFailure(error: unknown): BrowserRequestFailure | null {
  if (!isApiError(error)) return null;
  return {
    ok: false,
    error: error.code,
    code: error.code,
    message: error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.details ? { details: { ...error.details } } : {}),
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    issues: error.issues.map((issue) => ({ path: [...issue.path], code: issue.code, message: issue.message })),
  };
}

/**
 * What to tell the person about a failed request, or null when nothing should
 * be shown (`superseded`: they switched Workspace or signed out meanwhile, so
 * the result no longer belongs to this screen). The wording follows the stable
 * error code, never the message text.
 */
export function apiErrorMessage(error: unknown, fallback: string): string | null {
  const { kind } = describeApiFailure(error);
  if (kind === "superseded") return null;
  if (kind === "offline") return "You appear to be offline. Check your connection and try again.";
  const failure = browserFailure(error);
  if (!failure) return fallback;
  const destination = typeof window === "undefined" ? "/home" : window.location.pathname;
  return authenticatedRequestFailureMessage(failure, destination, fallback);
}

/** The request ID to quote to support, when the server sent one. */
export function apiErrorSupportId(error: unknown): string | null {
  return isApiError(error) ? error.requestId : null;
}

/** A failed request as an inline alert, with the Support ID. */
export function ApiErrorNotice({ error, fallback }: { error: unknown; fallback: string }) {
  const message = apiErrorMessage(error, fallback);
  if (message === null) return null;
  const supportId = apiErrorSupportId(error);
  return (
    <Text role="alert" fontSize="sm" color="danger.fg" mt="2">
      {message}
      {supportId ? ` Support ID: ${supportId}` : ""}
    </Text>
  );
}

/** A screen whose read failed: what could not load, the Support ID, and a retry. Nothing about the data has changed. */
export function QueryLoadError({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}) {
  const message = apiErrorMessage(error, `${what} could not be loaded.`);
  if (message === null) return null;
  const supportId = apiErrorSupportId(error);
  return (
    <Stack gap="3" role="alert" align="flex-start">
      <Text fontSize="13px" color="fg.muted">
        {describeApiFailure(error).kind === "offline" ? message : `${what} could not be loaded.`}
        {supportId ? ` Support ID: ${supportId}` : ""}
      </Text>
      <Button size="sm" variant="subtle" onClick={onRetry}>
        Try again
      </Button>
    </Stack>
  );
}

interface QueryMutationFormProps<TVariables>
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "children" | "onSubmit"> {
  /** `useMutation(...)` for the command this form submits. */
  mutation: Pick<UseMutationResult<unknown, Error, TVariables>, "mutate" | "isPending" | "error">;
  /** Turns the fields into the command's input. Runs on submit, with the browser's own values. */
  toVariables: (formData: FormData, form: HTMLFormElement) => TVariables;
  fallbackMessage?: string;
  /** The caller renders the failure itself (for example with recovery hints). */
  hideError?: boolean;
  children: ReactNode | ((state: { pending: boolean }) => ReactNode);
}

/**
 * A form that submits through a React Query mutation: pending state and the
 * failure message come from the mutation, not from a Server Action. Success
 * effects (navigation, cache writes) belong to the mutation's own options.
 */
export function QueryMutationForm<TVariables>({
  mutation,
  toVariables,
  fallbackMessage = "The action could not be completed.",
  hideError = false,
  children,
  ...formProps
}: QueryMutationFormProps<TVariables>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const form = event.currentTarget;
    mutation.mutate(toVariables(new FormData(form), form));
  }
  return (
    <form {...formProps} onSubmit={onSubmit}>
      {typeof children === "function" ? children({ pending: mutation.isPending }) : children}
      {mutation.error && !hideError ? <ApiErrorNotice error={mutation.error} fallback={fallbackMessage} /> : null}
    </form>
  );
}
