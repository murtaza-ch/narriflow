import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SocialAccount } from "@prisma/client";
import { TokenExchangeRejected } from "./token-exchange-rejected";
type Tx = Prisma.TransactionClient;
export type SocialTokenRefreshCode =
	| "social_account_missing"
	| "social_account_refresh_missing"
	| "social_account_refresh_in_progress"
	| "social_account_refresh_unconfirmed";
export class SocialTokenRefreshError extends Error {
	constructor(readonly code: SocialTokenRefreshCode) {
		super(code);
		this.name = "SocialTokenRefreshError";
	}
}
export interface SocialTokenReplacement {
	accessTokenEncrypted: string;
	refreshTokenEncrypted: string | null;
	expiresAt: Date | null;
	scopes: string[];
}
async function clock(tx: Tx) {
	const [row] = await tx.$queryRaw<
		Array<{ epoch: number; now: Date }>
	>`SELECT "epoch",clock_timestamp() AT TIME ZONE 'UTC' AS "now" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
	if (!row)
		throw new SocialTokenRefreshError("social_account_refresh_in_progress");
	return row;
}
async function locked(tx: Tx, id: string) {
	const owner = await tx.socialAccount.findUnique({
		where: { id },
		select: { workspaceId: true },
	});
	if (owner?.workspaceId)
		await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${owner.workspaceId}::uuid FOR SHARE`;
	await tx.$queryRaw`SELECT "id" FROM "SocialAccount" WHERE "id"=${id}::uuid FOR UPDATE`;
	return tx.socialAccount.findUnique({ where: { id } });
}
function sameCredential(a: SocialAccount, b: SocialAccount) {
	return (
		a.accessTokenEncrypted === b.accessTokenEncrypted &&
		a.refreshTokenEncrypted === b.refreshTokenEncrypted &&
		a.status === b.status &&
		a.workspaceId === b.workspaceId &&
		a.userId === b.userId &&
		a.platform === b.platform &&
		a.providerAccountId === b.providerAccountId
	);
}
const missing = { error: "social_account_missing" as const },
	busy = { error: "social_account_refresh_in_progress" as const };
/** Exactly one admitted provider exchange per account. The marker survives a
 * crashed/unknown rotation; only explicit reconnect may clear that uncertainty.
 * An exchange that throws `TokenExchangeRejected` proves nothing rotated: the
 * claim is released and the cause is rethrown. The account stays as it was for
 * the caller to retry, unless the provider refused the grant itself, which
 * expires it. */
export async function refreshSocialAccountToken(options: {
	database: PrismaClient;
	accountId: string;
	exchange(snapshot: Readonly<SocialAccount>): Promise<SocialTokenReplacement>;
	leaseMs?: number;
	refreshWindowMs?: number;
}) {
	const db = options.database,
		leaseMs = options.leaseMs ?? 30000,
		window = options.refreshWindowMs ?? 60000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000)
		throw new SocialTokenRefreshError("social_account_refresh_in_progress");
	const admitted = await db.$transaction(async (tx) => {
		const observed = await clock(tx),
			row = await locked(tx, options.accountId);
		if (!row || row.status === "revoked") return missing;
		if (row.tokenRefreshOwner) {
			if (row.tokenRefreshLeaseExpiresAt! > observed.now) return busy;
			if (row.tokenRefreshStartedAt) {
				await tx.socialAccount.update({
					where: { id: row.id },
					data: { status: "expired" },
				});
				return { error: "social_account_refresh_unconfirmed" as const };
			}
		}
		if (
			!row.expiresAt ||
			row.expiresAt.getTime() - observed.now.getTime() > window
		)
			return { row };
		if (!row.refreshTokenEncrypted)
			return { error: "social_account_refresh_missing" as const };
		const owner = randomUUID(),
			expiresAt = new Date(observed.now.getTime() + leaseMs);
		const current = await tx.socialAccount.update({
			where: { id: row.id },
			data: {
				tokenRefreshOwner: owner,
				tokenRefreshLeaseExpiresAt: expiresAt,
				tokenRefreshStartedAt: null,
			},
		});
		return { claim: { epoch: observed.epoch, owner, row: current } };
	});
	if ("error" in admitted) throw new SocialTokenRefreshError(admitted.error!);
	if ("row" in admitted) return admitted.row!;
	const claim = admitted.claim;
	const started = await db.$transaction(async (tx) => {
		const observed = await clock(tx),
			row = await locked(tx, options.accountId);
		if (!row || row.status === "revoked") return missing;
		if (
			observed.epoch !== claim.epoch ||
			row.tokenRefreshOwner !== claim.owner ||
			!sameCredential(row, claim.row) ||
			row.tokenRefreshStartedAt ||
			!row.tokenRefreshLeaseExpiresAt ||
			row.tokenRefreshLeaseExpiresAt <= observed.now
		)
			return busy;
		await tx.socialAccount.update({
			where: { id: row.id },
			data: { tokenRefreshStartedAt: observed.now },
		});
		return { started: true };
	});
	if ("error" in started) throw new SocialTokenRefreshError(started.error);
	let replacement: SocialTokenReplacement | undefined;
	let rejected: TokenExchangeRejected | undefined;
	try {
		replacement = await options.exchange(claim.row);
	} catch (error) {
		/* A started exchange can have rotated a token even without an ACK. */
		if (error instanceof TokenExchangeRejected) rejected = error;
	}
	const outcome = await db.$transaction(async (tx) => {
		const observed = await clock(tx),
			row = await locked(tx, options.accountId);
		if (!row || row.status === "revoked") return missing;
		if (
			observed.epoch !== claim.epoch ||
			row.tokenRefreshOwner !== claim.owner ||
			!sameCredential(row, claim.row)
		)
			return busy;
		if (rejected) {
			await tx.socialAccount.update({
				where: { id: row.id },
				// The database releases a started marker only with a credential write.
				data: {
					...rejected.resealed,
					...(rejected.credentialRefused ? { status: "expired" as const } : {}),
					tokenRefreshOwner: null,
					tokenRefreshLeaseExpiresAt: null,
					tokenRefreshStartedAt: null,
				},
			});
			return { rejected };
		}
		if (
			!replacement ||
			!replacement.accessTokenEncrypted ||
			!row.tokenRefreshStartedAt ||
			!row.tokenRefreshLeaseExpiresAt ||
			row.tokenRefreshLeaseExpiresAt <= observed.now
		) {
			await tx.socialAccount.update({
				where: { id: row.id },
				data: { status: "expired" },
			});
			return { error: "social_account_refresh_unconfirmed" as const };
		}
		const changed = await tx.socialAccount.updateMany({
			where: {
				id: row.id,
				status: claim.row.status,
				accessTokenEncrypted: claim.row.accessTokenEncrypted,
				refreshTokenEncrypted: claim.row.refreshTokenEncrypted,
				tokenRefreshOwner: claim.owner,
			},
			data: {
				...replacement,
				status: "active",
				tokenRefreshOwner: null,
				tokenRefreshLeaseExpiresAt: null,
				tokenRefreshStartedAt: null,
			},
		});
		return changed.count === 1
			? {
					row: await tx.socialAccount.findUniqueOrThrow({
						where: { id: row.id },
					}),
				}
			: busy;
	});
	if ("rejected" in outcome) throw outcome.rejected!.cause;
	if ("error" in outcome) throw new SocialTokenRefreshError(outcome.error!);
	return outcome.row!;
}
