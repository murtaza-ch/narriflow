import {
	PublicationPlatformExecutionError,
	type PublicationPlatform,
	type PublicationPlatformResult,
} from "./social-publication-platform";

export function createDeterministicPublicationPlatform(
	results: readonly PublicationPlatformResult[],
	options: {
		failurePoint?: "before_submission" | "after_submission";
	} = {},
): PublicationPlatform {
	let index = 0;
	return {
		capabilities: {
			recovery: "exact",
			asynchronous: true,
			idempotency: "provider",
			requiredScopes: [],
			capabilityVersion: "deterministic-v1",
			apiVersion: "deterministic-v1",
			maxProviderCalls: 10,
		},
		async publish(_input, context) {
			if (options.failurePoint === "before_submission") {
				throw new PublicationPlatformExecutionError(
					"deterministic_before_submission",
					"submission",
					"Injected failure before submission",
				);
			}
			await context.checkpoint({
				kind: "submission_started",
				state: { deterministic: true },
			});
			if (options.failurePoint === "after_submission") {
				throw new PublicationPlatformExecutionError(
					"deterministic_after_submission",
					"submission",
					"Injected failure after submission",
				);
			}
			const result = results[Math.min(index, results.length - 1)];
			if (!result) {
				throw new PublicationPlatformExecutionError(
					"deterministic_result_missing",
					"submission",
					"No deterministic result is configured",
				);
			}
			index += 1;
			return result;
		},
		async reconcile(_input, _operation, context) {
			return this.publish(_input, context);
		},
	};
}
