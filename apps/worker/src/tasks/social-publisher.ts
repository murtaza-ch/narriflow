import { randomUUID } from "node:crypto";
import {
	getSocialPublicationRuntime,
	PublicationClaimLostError,
	type OwnedPublicationAttempt,
} from "@narriflow/services";

const publisherWorkerId = `social-publisher:${process.pid}:${randomUUID()}`;

type PublicationRuntime = Pick<
	ReturnType<typeof getSocialPublicationRuntime>,
	"config" | "claimDue" | "heartbeat" | "attempt"
>;

type PublicationWorkerLog = (
	level: "info" | "warn" | "error",
	message: string,
	context: Record<string, unknown>,
) => void;

const structuredLog: PublicationWorkerLog = (level, message, context) => {
	console.warn(
		JSON.stringify({
			level,
			message,
			ts: new Date().toISOString(),
			...context,
		}),
	);
};

async function executeOwnedAttempt(
	owned: OwnedPublicationAttempt,
	runtime: PublicationRuntime,
	log: PublicationWorkerLog,
	shutdownSignal?: AbortSignal,
) {
	const controller = new AbortController();
	const abortForShutdown = () => controller.abort();
	shutdownSignal?.addEventListener("abort", abortForShutdown, { once: true });
	if (shutdownSignal?.aborted) controller.abort();
	const deadline = setTimeout(
		() => controller.abort(),
		runtime.config.worker.providerDeadlineMs,
	);
	const heartbeat = setInterval(() => {
		runtime.heartbeat(owned).catch((error) => {
			if (error instanceof PublicationClaimLostError) {
				controller.abort();
				return;
			}
			log("warn", "social_publication_heartbeat_failed", {
				attemptId: owned.attemptId,
				claimId: owned.claimId,
				errorCode: "publication_heartbeat_failed",
			});
		});
	}, runtime.config.worker.heartbeatMs);
	try {
		const result = await runtime.attempt.execute({
			attempt: owned,
			signal: controller.signal,
		});
		log("info", "social_publication_attempt_finished", {
			attemptId: owned.attemptId,
			claimId: owned.claimId,
			outcome: result.kind,
		});
	} catch (error) {
		if (error instanceof PublicationClaimLostError) {
			log("warn", "social_publication_claim_lost", {
				attemptId: owned.attemptId,
				claimId: owned.claimId,
			});
			return;
		}
		throw error;
	} finally {
		shutdownSignal?.removeEventListener("abort", abortForShutdown);
		clearInterval(heartbeat);
		clearTimeout(deadline);
	}
}

async function runBounded(
	attempts: OwnedPublicationAttempt[],
	concurrency: number,
	execute: (attempt: OwnedPublicationAttempt) => Promise<void>,
	log: PublicationWorkerLog,
	shouldStop?: () => boolean,
): Promise<number> {
	let started = 0;
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, attempts.length) },
		async () => {
			for (;;) {
				if (shouldStop?.()) return;
				const index = cursor;
				cursor += 1;
				const attempt = attempts[index];
				if (!attempt) return;
				started += 1;
				await execute(attempt).catch((error) => {
					log("error", "social_publication_attempt_crashed", {
						attemptId: attempt.attemptId,
						claimId: attempt.claimId,
						errorCode:
							error instanceof Error
								? "social_publication_attempt_crashed"
								: "unknown_error",
					});
				});
			}
		},
	);
	await Promise.all(workers);
	return started;
}

export function createSocialPublisherWorker(dependencies: {
	runtime: PublicationRuntime;
	workerId: string;
	log?: PublicationWorkerLog;
	shutdownSignal?: AbortSignal;
}) {
	const log = dependencies.log ?? structuredLog;
	return {
		async processDuePosts() {
			if (dependencies.shutdownSignal?.aborted) return 0;
			const claimed = await dependencies.runtime.claimDue(
				dependencies.workerId,
			);
			if (claimed.length === 0) return 0;
			return runBounded(
				claimed,
				dependencies.runtime.config.worker.concurrency,
				(attempt) =>
					executeOwnedAttempt(
						attempt,
						dependencies.runtime,
						log,
						dependencies.shutdownSignal,
				),
				log,
				() => dependencies.shutdownSignal?.aborted ?? false,
			);
		},
	};
}

export async function processDueSocialPosts(shutdownSignal?: AbortSignal) {
	return createSocialPublisherWorker({
		runtime: getSocialPublicationRuntime(),
		workerId: publisherWorkerId,
		shutdownSignal,
	}).processDuePosts();
}
