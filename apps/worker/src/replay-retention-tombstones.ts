import { projectRetentionService } from "@narriflow/services";

const result = await projectRetentionService.replayDeletionTombstones();
console.warn(
  JSON.stringify({
    level: result.invalidTombstones > 0 ? "warn" : "info",
    message: "retention_tombstones_replayed",
    ...result,
    ts: new Date().toISOString(),
  }),
);
