import { describe, expect, test } from "bun:test";
import { createIsolatedPollLoop } from "./poll-loop";

describe("isolated worker poll loops", () => {
  test("upload maintenance completes while an unrelated ingest tick remains busy", async () => {
    let releaseIngest!: () => void;
    const ingestBlocked = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    let uploadsReconciled = 0;
    const ingest = createIsolatedPollLoop({
      name: "ingest",
      run: async () => {
        await ingestBlocked;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });
    const uploadMaintenance = createIsolatedPollLoop({
      name: "upload_session_maintenance",
      run: async () => {
        uploadsReconciled += 1;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });

    const ingestTick = ingest.tick();
    await uploadMaintenance.tick();

    expect(ingest.status().polling).toBe(true);
    expect(uploadMaintenance.status().polling).toBe(false);
    expect(uploadsReconciled).toBe(1);
    releaseIngest();
    await ingestTick;
  });
});
