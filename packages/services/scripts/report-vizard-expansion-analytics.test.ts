import { describe, expect, test } from "bun:test";

import { parseCampaignAnalyticsReportArgs } from "./report-vizard-expansion-analytics";

describe("Vizard expansion analytics operator", () => {
  test("parses one fixed UTC window and an optional workspace cohort", () => {
    const firstWorkspace = crypto.randomUUID();
    const secondWorkspace = crypto.randomUUID();
    expect(
      parseCampaignAnalyticsReportArgs([
        "--from",
        "2026-08-01T00:00:00.000Z",
        "--to",
        "2026-09-01T00:00:00.000Z",
        "--workspace",
        firstWorkspace,
        "--workspace",
        secondWorkspace,
      ]),
    ).toEqual({
      windowStart: new Date("2026-08-01T00:00:00.000Z"),
      windowEnd: new Date("2026-09-01T00:00:00.000Z"),
      workspaceIds: [firstWorkspace, secondWorkspace],
    });
  });

  test("leaves the cohort global when no workspace IDs are supplied", () => {
    expect(
      parseCampaignAnalyticsReportArgs([
        "--from",
        "2026-08-01T00:00:00.000Z",
        "--to",
        "2026-09-01T00:00:00.000Z",
      ]),
    ).not.toHaveProperty("workspaceIds");
  });
});
