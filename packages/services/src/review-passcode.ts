import { timingSafeEqual } from "node:crypto";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ITERATIONS = 600_000;
const ENCODED_HASH = /^pbkdf2-sha256\$600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;

function validPasscode(passcode: string) {
  return passcode.length >= 1 && passcode.length <= 128;
}

/** Workers' native PBKDF2 caps iterations at 100k. This keeps the specified 600k work factor. */
async function derive(passcode: string, salt: Uint8Array) {
  return pbkdf2Async(sha256, new TextEncoder().encode(passcode), salt, { c: ITERATIONS, dkLen: 32 });
}

export async function hashReviewPasscode(passcode: string): Promise<string> {
  if (!validPasscode(passcode)) throw new RangeError("Review passcode must contain between 1 and 128 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(passcode, salt);
  try { return `pbkdf2-sha256$600000$${Buffer.from(salt).toString("hex")}$${Buffer.from(key).toString("hex")}`; }
  finally { key.fill(0); }
}

export async function verifyReviewPasscode(passcode: string, encoded: string): Promise<boolean> {
  if (!validPasscode(passcode)) return false;
  const match = ENCODED_HASH.exec(encoded);
  if (!match) return false;
  const expected = Buffer.from(match[2]!, "hex");
  const key = await derive(passcode, Buffer.from(match[1]!, "hex"));
  try { return timingSafeEqual(key, expected); }
  finally { key.fill(0); }
}
