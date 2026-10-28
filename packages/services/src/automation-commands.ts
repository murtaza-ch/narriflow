import type { AutopilotRuleInput, AutopilotRuleSnapshot } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type { AutopilotService } from "./autopilot.service";
import { AUTOMATION_RECEIPT_COMMANDS } from "./automation-receipt-commands";
import type { IntegrationMutation } from "./operation-receipt";

/** Dependencies of the automation receipt-backed commands. */
export interface AutomationCommandDependencies {
	autopilot: Pick<AutopilotService, "acceptRule" | "acceptRunNow">;
}

/** The transport facts a rule creation or run-now needs: the caller's key and the new-work limiter. */
export type AutomationMutation = Pick<IntegrationMutation, "clientIdempotencyKey" | "beforeAccept">;

export interface AcceptedRule {
	rule: AutopilotRuleSnapshot;
	replayed: boolean;
}

/**
 * Receipt-backed retryable commands of the automation domain: creating an
 * Autopilot rule and running one now. They record the same
 * `create_rss_autopilot_rule` and `run_autopilot_rule_now` receipts as MCP, so a
 * browser retry and an assistant retry of one key replay one acceptance. Only names
 * registered in `AUTOMATION_RECEIPT_COMMANDS` may be recorded. Rule edits, take-over and
 * Standing Grant changes keep their native guards (state transitions, the duplicate-grant
 * check) and take no key.
 */
export function createAutomationCommands(dependencies: AutomationCommandDependencies) {
	const { autopilot } = dependencies;
	return {
		receiptCommands: AUTOMATION_RECEIPT_COMMANDS,
		createRule: (actor: ActorScope, input: AutopilotRuleInput, mutation: AutomationMutation): Promise<AcceptedRule> =>
			autopilot.acceptRule(actor, input, mutation),
		runRuleNow: (actor: ActorScope, ruleId: string, mutation: AutomationMutation): Promise<AcceptedRule> =>
			autopilot.acceptRunNow(actor, ruleId, mutation),
	};
}

export type AutomationCommands = ReturnType<typeof createAutomationCommands>;
