/** Thrown by a refresh `exchange` when the provider answered and refused it
 * (a 4xx, or a provider that never rotates), so no token can have changed.
 * Any other thrown error means the outcome is unknown. `cause` is what the
 * refresh rethrows after releasing its claim. `resealed` is the unchanged
 * credentials under fresh ciphertext, for stores whose started marker only
 * clears together with a credential write. `credentialRefused` is the provider
 * saying the grant itself is dead: the account is marked expired as well. */
export class TokenExchangeRejected extends Error {
	constructor(
		override readonly cause: unknown,
		readonly resealed?: {
			accessTokenEncrypted: string;
			refreshTokenEncrypted: string | null;
		},
		readonly credentialRefused = false,
	) {
		super("token_exchange_rejected");
		this.name = "TokenExchangeRejected";
	}
}
