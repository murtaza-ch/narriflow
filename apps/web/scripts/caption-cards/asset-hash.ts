import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Re-recording identical source can repair a bad take, so cache URLs must identify the actual media bytes. */
export function captionCardAssetHash(video: string, poster: string): string {
  return createHash("sha256").update(readFileSync(video)).update(readFileSync(poster)).digest("hex");
}
