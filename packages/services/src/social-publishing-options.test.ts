import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { socialPublishingOptions } from "./social-publishing-options";
import { workspaceService } from "./workspace.service";

const globals = createDatabaseTestContext();
const previous = globals.client;
const previousUrl = process.env.DATABASE_URL;
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(bindServiceTestEnvironment(globals.bind(() => { globals.client = previous; if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl; for (const mock of mocks.splice(0)) mock.mockRestore(); })));

test("publishing options permit workspace readers and expose product facts without credentials", bindServiceTestEnvironment(globals.bind(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  const admission = spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: "user", workspaceId: "workspace", workspaceName: "Team", workspaceOwnerUserId: "owner", role: "viewer", status: "active", pricingTier: "business", isPersonalWorkspace: false });
  mocks.push(admission);
  let where: unknown;
  globals.client = { socialAccount: { findFirst: async (input: { where: unknown }) => { where = input.where; return { id: "account", workspaceId: "workspace", platform: "youtube_shorts", status: "active", scopes: [], encryptedAccessToken: "private-access-token" }; } } } as unknown as PrismaClient;
  const result = await socialPublishingOptions({ actorUserId: "user", workspaceId: "workspace" }, "account");
  expect(admission).toHaveBeenCalledWith("user", "workspace", "content.view");
  expect(where).toEqual({ id: "account", workspaceId: "workspace" });
  expect(result).toMatchObject({ platform: "youtube_shorts", directEnabled: true });
  expect(JSON.stringify(result)).not.toContain("private-access-token");
})));
