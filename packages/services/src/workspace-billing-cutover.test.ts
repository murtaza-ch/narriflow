import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(
  new URL("../../db/prisma/schema.prisma", import.meta.url),
  "utf8",
);

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match?.[1]) throw new Error(`Missing Prisma model ${modelName}`);
  return match[1];
}

describe("Workspace billing direct cutover", () => {
  test("User has no billing or entitlement state", () => {
    const user = modelBody("User");

    expect(user).not.toMatch(/\bpricingTier\b/);
    expect(user).not.toMatch(/\bstripeCustomerId\b/);
    expect(user).not.toMatch(/\bbillingEventCreatedAt\b/);
  });

  test("Workspace Billing Account owns provider subscription identity", () => {
    const account = modelBody("WorkspaceBillingAccount");

    expect(account).toMatch(/workspaceId\s+String\s+@unique/);
    expect(account).toMatch(/providerCustomerId\s+String\?\s+@unique/);
    expect(account).toMatch(/canonicalSubscriptionId\s+String\?\s+@unique/);

    const workspace = modelBody("Workspace");
    expect(workspace).not.toMatch(/\bstripeCustomerId\b/);
    expect(workspace).not.toMatch(/\bstripeSubscriptionId\b/);
    expect(workspace).not.toMatch(/\bbillingEventCreatedAt\b/);
  });

  test("the durable delivery ledger supports normalized Stripe envelopes", () => {
    expect(schema).toMatch(/enum WebhookProvider \{[\s\S]*\bstripe\b[\s\S]*\}/);
    const delivery = modelBody("WebhookDeliveryLog");
    expect(delivery).toMatch(/providerCreatedAt\s+DateTime\?/);
    expect(delivery).toMatch(/subjectCustomerId\s+String\?/);
    expect(delivery).toMatch(/workspaceBillingAccountId\s+String\?/);
    expect(delivery).not.toMatch(/\brawBody\b|\bsignature\b/);
  });

  test("obsolete billing routes and optimistic confirmation are absent", () => {
    const root = resolve(import.meta.dir, "../../..");
    const sources = [
      "apps/web/next.config.ts",
      "apps/web/app/(app)/home/page.tsx",
      "apps/web/app/(app)/dashboard/dashboard-client.tsx",
      "apps/web/app/(app)/_components/account-menu.tsx",
      "apps/web/app/(app)/_components/app-chrome.tsx",
      "apps/web/app/(app)/_components/plan-limit-notice.tsx",
      "apps/web/app/(app)/settings/layout.tsx",
      "apps/web/app/(marketing)/pricing/page.tsx",
      "apps/worker/src/notifications.ts",
    ].map((path) => readFileSync(resolve(root, path), "utf8"));

    expect(sources.join("\n")).not.toContain("/settings/subscription");
    expect(sources.join("\n")).not.toContain("/api/billing/confirm");
    expect(sources.join("\n")).not.toContain("upgraded=1");
  });
});
