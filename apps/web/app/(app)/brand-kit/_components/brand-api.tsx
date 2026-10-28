"use client";

import { describeApiFailure, type Intent, type WorkspaceScope } from "@narriflow/api-client";
import type { BrandMutations, BrandQueries } from "@narriflow/api-client/brand";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import type { InferDataFromTag, QueryClient } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { createContext, useContext, useState } from "react";

/** What a Brand Kit read resolves to, taken from the query factory so the screen never restates a response shape. */
export type BrandData<K extends keyof BrandQueries> = InferDataFromTag<
  unknown,
  ReturnType<BrandQueries[K]>["queryKey"]
>;

export interface BrandApiValue {
  scope: WorkspaceScope;
  queries: BrandQueries;
  mutations: BrandMutations;
  queryClient: QueryClient;
  /** Marks every Brand Kit read (and the aggregates that show brand data) stale after a confirmed change. */
  invalidate: () => Promise<void>;
  createIntent: <TInput>() => Intent<TInput>;
}

/** Exported so tests can render components against a stub API without a Clerk-backed runtime. */
export const BrandApiContext = createContext<BrandApiValue | null>(null);

export function useBrandApi(): BrandApiValue {
  const value = useContext(BrandApiContext);
  if (!value) throw new Error("useBrandApi must be used inside a Brand Kit screen");
  return value;
}

/** One idempotency intent per form: the same key through retries until the command is confirmed. */
export function useIntent<TInput>(): Intent<TInput> {
  const { createIntent } = useBrandApi();
  return useState(() => createIntent<TInput>())[0];
}

/** The server's own message for a refused or failed command, with the screen's copy as the fallback. */
export function failureMessage(error: unknown, fallback = "Please try again."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A failed first load: a missing profile or style is the app's not-found page
 * (the API conceals foreign ones the same way); anything else says so plainly
 * and retrying is one click.
 */
export function BrandLoadFailure({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  if (describeApiFailure(error).kind === "missing") notFound();
  return (
    <Stack gap="4" role="alert" align="flex-start">
      <Text fontSize="13px" color="fg.muted">
        {what} could not be loaded.
      </Text>
      <Button size="sm" variant="subtle" onClick={onRetry}>
        Try again
      </Button>
    </Stack>
  );
}
