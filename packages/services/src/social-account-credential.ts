import { getPrismaClient } from "@narriflow/db/client";
import {
	socialOAuthService,
	SocialOAuthError,
	type PublishSocialAccount,
} from "./social-oauth.service";

/**
 * One verdict on whether a connected Social Account can still publish, shared
 * by the composer's options read and by schedule admission.
 *
 * This is a refresh preflight: `getPublishAccount` refreshes the access token
 * when it is inside the refresh window and expires the account when the
 * provider refuses the grant. It cannot see a revoked token that carries no
 * expiry (Meta), or a dead refresh grant while the access token is still
 * outside the refresh window. It never calls the provider to identify the
 * account.
 */
export type SocialAccountCredential =
	| { kind: "ready"; account: PublishSocialAccount }
	/** The person must reconnect; retrying cannot help. */
	| { kind: "reconnect_required" }
	/** Not a verdict: a refresh in progress, a network or provider failure. */
	| { kind: "temporary"; error: unknown };

/** Failures that mean the stored connection is gone or unusable until reconnect. */
const RECONNECT_CODES: ReadonlySet<string> = new Set([
	"social_account_expired",
	"social_account_missing",
	"social_account_refresh_unconfirmed",
	"social_account_refresh_missing",
]);

export async function checkSocialAccountCredential(
	accountId: string,
): Promise<SocialAccountCredential> {
	let account: PublishSocialAccount;
	try {
		account = await socialOAuthService.getPublishAccount(accountId);
	} catch (error) {
		return error instanceof SocialOAuthError && RECONNECT_CODES.has(error.code)
			? { kind: "reconnect_required" }
			: { kind: "temporary", error };
	}
	// `getPublishAccount` returns an account whose stored status is already
	// `expired` while its access token is still in date, so read it again.
	try {
		const row = await getPrismaClient()?.socialAccount.findUnique({
			where: { id: accountId },
			select: { status: true },
		});
		if (row && row.status !== "active") return { kind: "reconnect_required" };
	} catch (error) {
		return { kind: "temporary", error };
	}
	return { kind: "ready", account };
}
