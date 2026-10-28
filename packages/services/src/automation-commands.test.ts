import { describe, expect, mock, test } from "bun:test";
import type { AutopilotRuleInput, AutopilotRuleSnapshot } from "@narriflow/validators";
import { AUTOMATION_RECEIPT_COMMANDS } from "./automation-receipt-commands";
import { createAutomationCommands } from "./automation-commands";

const actor = { actorUserId: "user", workspaceId: "workspace" };
const rule = { id: "rule" } as AutopilotRuleSnapshot;
const input = { name: "Podcast" } as AutopilotRuleInput;
const mutation = { clientIdempotencyKey: "key", beforeAccept: async () => {} };

describe("automation commands", () => {
	test("rule creation and run-now keep the receipt names MCP records", () => {
		const commands = createAutomationCommands({ autopilot: { acceptRule: mock(), acceptRunNow: mock() } as never });
		expect(commands.receiptCommands).toEqual(AUTOMATION_RECEIPT_COMMANDS);
		expect([...AUTOMATION_RECEIPT_COMMANDS]).toEqual(["create_rss_autopilot_rule", "run_autopilot_rule_now"]);
	});

	test("both commands hand the caller's key and limiter to the service and report a replay", async () => {
		const acceptRule = mock(async () => ({ rule, replayed: true }));
		const acceptRunNow = mock(async () => ({ rule, replayed: false }));
		const commands = createAutomationCommands({ autopilot: { acceptRule, acceptRunNow } });
		expect(await commands.createRule(actor, input, mutation)).toEqual({ rule, replayed: true });
		expect(await commands.runRuleNow(actor, "rule", mutation)).toEqual({ rule, replayed: false });
		expect(acceptRule).toHaveBeenCalledWith(actor, input, mutation);
		expect(acceptRunNow).toHaveBeenCalledWith(actor, "rule", mutation);
	});
});
