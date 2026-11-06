import { describe, expect, test } from "bun:test";
import { forwardProductEvents, productEventWindow, toProductEvent, type ProductEvent, type ProductEventRow } from "./product-events";

const row = (overrides: Partial<ProductEventRow>): ProductEventRow => ({ id: "row-1", source: "ledger", detail: null, state: null, at: new Date("2026-11-06T10:30:00Z"), distinctId: "user_clerk",
  workspaceId: "w", projectId: "p", clipId: null, platform: null, planTier: "pro", ...overrides });
const name = (overrides: Partial<ProductEventRow>) => toProductEvent(row(overrides))?.event ?? null;

describe("toProductEvent", () => {
  test("the funnel has one name per step", () => {
    expect(name({ source: "user" })).toBe("user_sign_up");
    expect(name({ source: "workspace" })).toBe("workspace_create");
    expect(name({ source: "project", detail: "upload" })).toBe("project_create");
    expect(name({ source: "operation", detail: "intake", state: "completed" })).toBe("import_complete");
    expect(name({ source: "operation", detail: "generation", state: "completed" })).toBe("clip_generation_complete");
    expect(name({ source: "export" })).toBe("clip_export_create");
    expect(name({ source: "ledger", detail: "social_posted" })).toBe("social_post_publish");
  });
  test("a failed operation can never be counted as a success", () => {
    expect(name({ source: "operation", detail: "generation", state: "failed" })).toBe("clip_generation_fail");
    expect(name({ source: "operation", detail: "export", state: "partial" })).toBe("clip_export_partial");
    expect(name({ source: "operation", detail: "intake", state: "cancelled" })).toBe("import_cancel");
    expect(name({ source: "operation", detail: "generation", state: "unknown" })).toBeNull();
  });
  test("plan changes read as revenue events", () => {
    expect(name({ source: "billing", detail: "free", planTier: "pro" })).toBe("subscription_start");
    expect(name({ source: "billing", detail: "creator", planTier: "business" })).toBe("subscription_upgrade");
    expect(name({ source: "billing", detail: "business", planTier: "pro" })).toBe("subscription_downgrade");
    expect(name({ source: "billing", detail: "pro", planTier: "free" })).toBe("subscription_cancel");
    expect(name({ source: "billing", detail: "pro", planTier: "pro" })).toBeNull();
  });
  test("internal ledger rows stay internal", () => {
    expect(name({ source: "ledger", detail: "motion_render_outcome" })).toBeNull();
  });
  test("a row keeps its id and time, so a resend is the same event", () => {
    const event = toProductEvent(row({ source: "export" }))!;
    expect(event.uuid).toBe("row-1");
    expect(event.timestamp).toEqual(new Date("2026-11-06T10:30:00Z"));
    expect(event.distinctId).toBe("user_clerk");
  });
  test("properties come from named columns and fill in a new person's plan", () => {
    const event = toProductEvent(row({ source: "project", detail: "youtube", clipId: "c", platform: "tiktok" }))!;
    expect(event.properties).toEqual({ workspace_id: "w", project_id: "p", clip_id: "c", platform: "tiktok", plan_tier: "pro", $set_once: { plan_tier: "pro" }, source_type: "youtube" });
  });
  test("an event with no plan or project leaves those properties out", () => {
    expect(toProductEvent(row({ source: "user", workspaceId: null, projectId: null, planTier: null }))!.properties).toEqual({});
  });
});

describe("publishing outcomes", () => {
  const row = (overrides: Partial<ProductEventRow>): ProductEventRow => ({
    id: "post", source: "ledger", detail: "social_failed", state: null, at: new Date(0), distinctId: "clerk", workspaceId: null, projectId: null,
    clipId: null, platform: "youtube_shorts", planTier: null, errorCode: null, delaySeconds: null, ...overrides,
  });

  test("a failed post says why, so failures can be broken down by cause", () => {
    expect(toProductEvent(row({ errorCode: "youtube_upload_limit_exceeded" }))).toMatchObject({
      event: "social_post_fail", properties: { platform: "youtube_shorts", error_code: "youtube_upload_limit_exceeded" },
    });
  });

  test("anything that is not a machine code stays out", () => {
    expect(toProductEvent(row({ errorCode: "A caption someone wrote" }))?.properties).not.toHaveProperty("error_code");
  });

  test("a published post carries how long it waited past its time", () => {
    expect(toProductEvent(row({ detail: "social_posted", delaySeconds: 761.4 }))?.properties.publish_delay_sec).toBe(761);
  });

  test("a post with no schedule or a clock skew reports no delay", () => {
    expect(toProductEvent(row({ detail: "social_posted" }))?.properties).not.toHaveProperty("publish_delay_sec");
    expect(toProductEvent(row({ detail: "social_posted", delaySeconds: -2 }))?.properties).not.toHaveProperty("publish_delay_sec");
  });
});

test("windows are whole hours that meet exactly, so nothing is lost or sent twice", () => {
  const first = productEventWindow(new Date("2026-11-06T10:00:00Z")), second = productEventWindow(new Date("2026-11-06T11:00:00Z"));
  expect(first.to).toEqual(second.from);
  expect(first.to).toEqual(new Date("2026-11-06T09:58:00Z"));
  expect(first.to.getTime() - first.from.getTime()).toBe(3_600_000);
});

describe("forwardProductEvents", () => {
  const database = (rows: ProductEventRow[] | Error) => ({ $queryRaw: async () => { if (rows instanceof Error) throw rows; return rows; } }) as never;
  const scheduledAt = new Date("2026-11-06T10:00:00Z");
  test("sends only mapped events", async () => {
    const sent: ProductEvent[][] = [];
    await forwardProductEvents({ scheduledAt, database: database([row({ source: "user" }), row({ source: "ledger", detail: "motion_render_outcome" })]), send: async events => { sent.push(events); } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map(event => event.event)).toEqual(["user_sign_up"]);
  });
  test("an empty hour makes no request", async () => {
    let calls = 0;
    await forwardProductEvents({ scheduledAt, database: database([]), send: async () => { calls++; } });
    expect(calls).toBe(0);
  });
  test("a PostHog or database outage never breaks the cron", async () => {
    await expect(forwardProductEvents({ scheduledAt, database: database(new Error("down")), send: async () => undefined })).resolves.toBeUndefined();
    await expect(forwardProductEvents({ scheduledAt, database: database([row({ source: "user" })]), send: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
  });
});

test("only a billing change moves a person's plan", () => {
  const base = { id: "e1", detail: null, state: null, at: new Date(0), distinctId: "user_1", workspaceId: "w1", projectId: null, clipId: null, platform: null };
  const created = toProductEvent({ ...base, source: "workspace", planTier: "free" });
  expect(created?.properties.$set).toBeUndefined();
  expect(created?.properties.$set_once).toEqual({ plan_tier: "free" });
  const upgraded = toProductEvent({ ...base, source: "billing", detail: "creator", planTier: "business" });
  expect(upgraded?.event).toBe("subscription_upgrade");
  expect(upgraded?.properties).toMatchObject({ plan_tier: "business", previous_tier: "creator", $set: { plan_tier: "business" } });
  expect(upgraded?.properties.$set_once).toBeUndefined();
});
