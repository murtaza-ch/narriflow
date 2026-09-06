import { describe, expect, test } from "bun:test";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

describe("ExpectedDomainFailure", () => {
  test("exposes a stable transport-neutral failure without changing typed metadata", () => {
    const failure = new ExpectedDomainFailureError({
      code: "review_approval_required",
      kind: "conflict",
      message: "Approve the selected exports before scheduling.",
      details: {
        roundId: "round-1",
        items: Array.from({ length: 20 }, (_, index) => ({
          exportId: `export-${index}`,
          reason: "approval_required",
        })),
        note: "x".repeat(300),
      },
      retryAfterSeconds: 2.2,
    });

    expect(failure).toMatchObject({
      name: "ExpectedDomainFailure",
      code: "review_approval_required",
      kind: "conflict",
      message: "Approve the selected exports before scheduling.",
      retryAfterSeconds: 3,
    });
    expect(failure.details).toEqual({
      roundId: "round-1",
      items: Array.from({ length: 20 }, (_, index) => ({
        exportId: `export-${index}`,
        reason: "approval_required",
      })),
      note: "x".repeat(300),
    });
  });
});
