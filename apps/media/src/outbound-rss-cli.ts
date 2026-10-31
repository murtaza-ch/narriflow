import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { MAX_RSS_RESULT_BYTES, outboundRssInputSchema, rssFeedSnapshotSchema } from "@narriflow/validators/outbound-probe";
import { ExpectedDomainFailureError } from "@narriflow/services/expected-domain-failure";
import { fetchRssFeed } from "./rss-fetch";

const commandSchema = z.object({ input: outboundRssInputSchema, outputPath: z.string().min(1).max(4096) }).strict();
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error("outbound_command_too_large"); chunks.push(chunk); }
  const { input, outputPath } = commandSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("outbound_cancelled"));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const timer = setTimeout(cancel, 30_000);
  try {
    const snapshot = rssFeedSnapshotSchema.parse(await fetchRssFeed(input.url, { etag: input.etag, lastModified: input.lastModified, signal: controller.signal }));
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > MAX_RSS_RESULT_BYTES) throw new Error("outbound_result_too_large");
    await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ byteLength: bytes.length })}\n`);
  } finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) main().catch(error => {
  const errorCode = error instanceof ExpectedDomainFailureError ? error.code : "outbound_request_failed";
  console.error(JSON.stringify({ level: "error", message: "outbound_request_failed", errorCode }));
  process.exitCode = 1;
});
