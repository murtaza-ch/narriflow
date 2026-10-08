import { createHash, randomUUID } from "node:crypto";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

/** Canonical names of the idempotent mutations integrations accept. Every
 * transport (browser, MCP, REST) records the same command for the same work. */
export const RECEIPT_COMMANDS = [
	"submit_video",
	"generate_clips",
	"create_clip_export",
	"create_rss_autopilot_rule",
	"run_autopilot_rule_now",
	"prepare_social_post",
	"recheck_social_publication",
	"confirm_social_publication",
	"publish_social_publication_again",
	"redeliver_callback",
] as const;
export type ReceiptCommand = (typeof RECEIPT_COMMANDS)[number];

/** An Operation Receipt is keyed by the acting user, never the credential, so
 * rotating a key or switching transports replays the original acceptance. */
export interface OperationReceiptIdentity {
	workspaceId: string;
	actorUserId: string;
	command: ReceiptCommand;
	clientIdempotencyKey: string;
}

/** Transport facts a service needs to accept an idempotent mutation. */
export interface IntegrationMutation {
	clientIdempotencyKey: string;
	beforeAccept?: () => Promise<void>;
	/** A validated Completion Callback URL, for commands that start work. */
	callback?: { url: URL };
}

/** Registers a Completion Callback in the acceptance transaction. Its
 * fingerprint joins the request fingerprint, so a replay with another URL
 * conflicts, and a replay never registers twice. */
export interface ReceiptCallback<Tx, T> {
	fingerprint: string;
	register(tx: Tx, accepted: { receiptId: string; value: T }): Promise<void>;
}

export interface OperationReceipt extends Omit<OperationReceiptIdentity, "command"> {
	command: string;
	id: string;
	fingerprint: string;
	resourceType: string;
	resourceId: string;
	result: unknown;
}

export interface OperationReceiptPersistence<Tx> {
	read(identity: OperationReceiptIdentity): Promise<OperationReceipt | null>;
	transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
	lock(tx: Tx, identity: OperationReceiptIdentity): Promise<void>;
	readInTransaction(
		tx: Tx,
		identity: OperationReceiptIdentity,
	): Promise<OperationReceipt | null>;
	create(tx: Tx, receipt: OperationReceipt): Promise<void>;
}

export class OperationIdempotencyConflictError extends ExpectedDomainFailureError<"operation_idempotency_conflict"> {
	constructor() {
		super({
			code: "operation_idempotency_conflict",
			kind: "conflict",
			message:
				"This request key was already accepted with different input. Use a new key for a new request.",
		});
		this.name = "OperationIdempotencyConflictError";
	}
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	if (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return JSON.stringify(value);
	throw new TypeError("Operation Receipt input and results must be JSON values");
}

export function operationFingerprint(input: unknown): string {
	return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function createOperationReceiptExecutor<Tx>(
	persistence: OperationReceiptPersistence<Tx>,
) {
	return {
		async execute<T>(input: {
			identity: OperationReceiptIdentity;
			input: unknown;
			authorize: () => Promise<void>;
			beforeAccept?: () => Promise<void>;
			prepare?: () => Promise<void>;
			callback?: ReceiptCallback<Tx, NoInfer<T>>;
			/** A mutation may commit a durable refusal, such as a released usage
			 * reservation, without a receipt. Its error reaches the caller after
			 * commit, and a replay re-evaluates against the committed state. */
			mutate: (
				tx: Tx,
			) => Promise<
				| { resourceType: string; resourceId: string; value: T }
				| { refusal: ExpectedDomainFailureError }
			>;
		}): Promise<{ receiptId: string; replayed: boolean; value: T }> {
			if (
				!input.identity.clientIdempotencyKey ||
				input.identity.clientIdempotencyKey.length > 200
			) {
				throw new ExpectedDomainFailureError({
					code: "operation_idempotency_key_required",
					kind: "invalid",
					message: "A bounded client idempotency key is required.",
				});
			}
			await input.authorize();
			const fingerprint = operationFingerprint(
				input.callback
					? { input: input.input, callback: input.callback.fingerprint }
					: input.input,
			);
			const replay = (receipt: OperationReceipt) => {
				if (receipt.fingerprint !== fingerprint)
					throw new OperationIdempotencyConflictError();
				return {
					receiptId: receipt.id,
					replayed: true,
					value: receipt.result as T,
				};
			};
			const existing = await persistence.read(input.identity);
			if (existing) return replay(existing);
			// Remote preparation never holds a database transaction. Recheck inside
			// the transaction because another process can accept while preparing.
			try {
				await input.prepare?.();
				const outcome = await persistence.transaction(async (tx) => {
					await persistence.lock(tx, input.identity);
					const accepted = await persistence.readInTransaction(
						tx,
						input.identity,
					);
					if (accepted) return replay(accepted);
					await input.beforeAccept?.();
					const result = await input.mutate(tx);
					if ("refusal" in result) return result;
					const id = randomUUID();
					// Store a JSON snapshot, never a mutable object owned by the caller.
					const value = JSON.parse(canonicalJson(result.value)) as T;
					await persistence.create(tx, {
						...input.identity,
						id,
						fingerprint,
						resourceType: result.resourceType,
						resourceId: result.resourceId,
						result: value,
					});
					await input.callback?.register(tx, { receiptId: id, value });
					return { receiptId: id, replayed: false, value };
				});
				if ("refusal" in outcome) throw outcome.refusal;
				return outcome;
			} catch (error) {
				// Resolve a concurrent acceptance or a lost commit response before
				// reporting mutable admission failures. Preserve the original error
				// when the database cannot resolve the durable identity.
				const accepted = await persistence
					.read(input.identity)
					.catch(() => null);
				if (accepted) return replay(accepted);
				throw error;
			}
		},
	};
}
