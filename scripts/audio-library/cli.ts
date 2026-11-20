#!/usr/bin/env bun
/**
 * Curated audio library ingest. Each step is idempotent.
 *
 *   bun scripts/audio-library/cli.ts fetch   [--dry-run]   download sources into ~/.cache/narriflow-audio-library
 *   bun scripts/audio-library/cli.ts build   [--dry-run]   encode, hash, write packages/db/audio-library/manifest.json
 *   bun scripts/audio-library/cli.ts upload  [--dry-run]   PutObject to the private and public buckets
 *   bun scripts/audio-library/cli.ts sync-db [--dry-run]   upsert curated AudioAsset rows
 */
import { describeError, flag, log } from "./util";

const COMMANDS = ["fetch", "build", "upload", "sync-db"] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  const dryRun = flag("--dry-run");
  if (!command || !COMMANDS.includes(command)) {
    console.error(`Usage: bun scripts/audio-library/cli.ts <${COMMANDS.join("|")}> [--dry-run]`);
    process.exit(2);
  }
  if (command === "fetch") await (await import("./fetch")).runFetch(dryRun);
  else if (command === "build") await (await import("./build")).runBuild(dryRun);
  else if (command === "upload") await (await import("./upload")).runUpload(dryRun);
  else await (await import("./sync-db")).runSyncDb(dryRun);
}

main().catch((error) => {
  log("audio_library_failed", { error: describeError(error) });
  process.exit(1);
});
