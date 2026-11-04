import { describeApiFailure } from "@narriflow/api-client/core";

/** The part of a React Query result a page gate reads. */
interface GatedQuery {
  readonly data: unknown;
  readonly error: unknown;
  readonly isError: boolean;
  refetch(): unknown;
}

type Loaded<Queries extends readonly GatedQuery[]> = { [Index in keyof Queries]: NonNullable<Queries[Index]["data"]> };

export type QueryGate<Queries extends readonly GatedQuery[]> =
  | { status: "failed"; error: unknown; retry(): void }
  | { status: "loading" }
  | { status: "ready"; data: Loaded<Queries> };

/**
 * One gate for a page that starts several reads together: failed when any read
 * failed with nothing to show for it (a failed background refresh keeps the
 * data it has), loading until all have data, then ready with every result in
 * order. A failure from a Workspace switch or sign-out (`superseded`) is not
 * shown: the page is about to be replaced. `retry` refetches only the failed reads.
 */
export function gateQueries<const Queries extends readonly GatedQuery[]>(queries: Queries): QueryGate<Queries> {
  const failed = queries.find(
    (query) => query.isError && query.data === undefined && describeApiFailure(query.error).kind !== "superseded",
  );
  if (failed) {
    return {
      status: "failed",
      error: failed.error,
      retry: () => {
        for (const query of queries) if (query.isError) void query.refetch();
      },
    };
  }
  if (queries.some((query) => query.data === undefined || query.data === null)) return { status: "loading" };
  return { status: "ready", data: queries.map((query) => query.data) as unknown as Loaded<Queries> };
}
