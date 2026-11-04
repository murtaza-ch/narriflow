import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM sealing in the `v1:iv:tag:ciphertext` form every stored secret
 * here uses. Each caller owns its key and what a malformed value throws. */
export function createSealedValueCipher(key: Buffer, malformed: () => Error) {
	return {
		seal(value: string) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
		},
		open(sealed: string) {
			const [version, iv, tag, ciphertext] = sealed.split(":");
			if (version !== "v1" || !iv || !tag || !ciphertext) throw malformed();
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
			decipher.setAuthTag(Buffer.from(tag, "base64url"));
			return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
		},
	};
}
