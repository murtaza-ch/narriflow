import { createHash, randomUUID } from "node:crypto";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

export interface McpOperationIdentity {
	workspaceId: string;
	callerId: string;
	toolName: string;
	clientIdempotencyKey: string;
}

export interface McpMutationOptions {
	clientIdempotencyKey: string;
	callerId?: string;
	beforeAccept?: () => Promise<void>;
}

export interface McpOperationReceipt extends McpOperationIdentity {
	id: string;
	fingerprint: string;
	resourceType: string;
	resourceId: string;
	result: unknown;
}

export interface McpOperationPersistence<Tx> {
	read(identity: McpOperationIdentity): Promise<McpOperationReceipt | null>;
	transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
	lock(tx: Tx, identity: McpOperationIdentity): Promise<void>;
	readInTransaction(
		tx: Tx,
		identity: McpOperationIdentity,
	): Promise<McpOperationReceipt | null>;
	create(tx: Tx, receipt: McpOperationReceipt): Promise<void>;
}

export class McpOperationConflictError extends ExpectedDomainFailureError<"mcp_idempotency_conflict"> {
	constructor() {
		super({
			code: "mcp_idempotency_conflict",
			kind: "conflict",
			message:
				"This request key was already accepted with different input. Use a new key for a new request.",
		});
		this.name = "McpOperationConflictError";
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
	throw new TypeError("MCP operation input and results must be JSON values");
}

export function mcpOperationFingerprint(input: unknown): string {
	return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function createMcpOperationExecutor<Tx>(
	persistence: McpOperationPersistence<Tx>,
) {
	return {
		async execute<T>(input: {
			identity: McpOperationIdentity;
			input: unknown;
			authorize: () => Promise<void>;
			beforeAccept?: () => Promise<void>;
			prepare?: () => Promise<void>;
			mutate: (
				tx: Tx,
			) => Promise<{ resourceType: string; resourceId: string; value: T }>;
		}): Promise<{ operationId: string; replayed: boolean; value: T }> {
			if (
				!input.identity.clientIdempotencyKey ||
				input.identity.clientIdempotencyKey.length > 200
			) {
				throw new ExpectedDomainFailureError({
					code: "mcp_idempotency_key_required",
					kind: "invalid",
					message: "A bounded client idempotency key is required.",
				});
			}
			await input.authorize();
			const fingerprint = mcpOperationFingerprint(input.input);
			const replay = (receipt: McpOperationReceipt) => {
				if (receipt.fingerprint !== fingerprint)
					throw new McpOperationConflictError();
				return {
					operationId: receipt.id,
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
				return await persistence.transaction(async (tx) => {
					await persistence.lock(tx, input.identity);
					const accepted = await persistence.readInTransaction(
						tx,
						input.identity,
					);
					if (accepted) return replay(accepted);
					await input.beforeAccept?.();
					const result = await input.mutate(tx);
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
					return { operationId: id, replayed: false, value };
				});
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
