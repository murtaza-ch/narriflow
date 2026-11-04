import { describe, expect, test } from "bun:test";
import { parseProcessingUsageOperatorArgs } from "./processing-usage-operator";

const needId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";

describe("Processing Usage operator command", () => {
  test("defaults to a read-only list", () => {
    expect(parseProcessingUsageOperatorArgs([])).toEqual({ mode: "list" });
  });

  test("a refund names the need, the actor, and a reason", () => {
    expect(
      parseProcessingUsageOperatorArgs(["--refund", needId, "--actor", actorUserId, "--reason", " Audio did not match "]),
    ).toEqual({ mode: "refund", needId, actorUserId, reason: "Audio did not match" });
    expect(() => parseProcessingUsageOperatorArgs(["--refund", needId])).toThrow("--actor");
    expect(() => parseProcessingUsageOperatorArgs(["--refund", needId, "--actor", actorUserId, "--reason", " "])).toThrow("--reason");
    expect(() => parseProcessingUsageOperatorArgs(["--actor", actorUserId])).toThrow("--refund");
    expect(() => parseProcessingUsageOperatorArgs(["--refund", "not-an-id"])).toThrow("valid Source Refund Need UUID");
    expect(() => parseProcessingUsageOperatorArgs(["--delete"])).toThrow("Unknown argument");
  });
});
