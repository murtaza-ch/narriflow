import { validateNativeAsset } from "./asset-validation";
import { WorkflowFailure } from "@narriflow/services/workflow-attempt-contract";
import { BrandFontIntegrityError } from "@narriflow/services/brand-font-contract";

async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024) throw new Error("asset_validation_command_too_large"); chunks.push(chunk); }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("asset_validation_cancelled"));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const timeout = setTimeout(cancel, 90_000);
  try { process.stdout.write(`${JSON.stringify(await validateNativeAsset(JSON.parse(Buffer.concat(chunks).toString("utf8")), controller.signal))}\n`); }
  finally { clearTimeout(timeout); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) main().catch((error: unknown) => {
  const errorCode = error instanceof WorkflowFailure || error instanceof BrandFontIntegrityError ? error.code
    : error instanceof Error && /^(?:brand_font|visual_asset|asset_validation)_[a-z_]{1,80}$/.test(error.message) ? error.message : "asset_validation_invalid";
  console.error(JSON.stringify({ level: "error", message: "asset_validation_failed", errorCode,
    retryable: error instanceof WorkflowFailure && error.disposition === "retryable" }));
  process.exitCode = 1;
});
