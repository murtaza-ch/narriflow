import { S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { createClipSelectionStorage } from "../../src/clip-selection-storage";

/** Synthetic loopback protocol fixture. No real account credential is accepted. */
export function createSyntheticSelectionStorage(origin: string) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) throw new Error("Synthetic storage requires loopback");
  return createClipSelectionStorage({ accountId: "a".repeat(32), bucket: "private", accessKeyId: "synthetic-memory-fixture", secretAccessKey: "synthetic-memory-fixture" }, {
    client: new S3Client({ region: "auto", endpoint: origin, forcePathStyle: true, credentials: { accessKeyId: "synthetic-memory-fixture", secretAccessKey: "synthetic-memory-fixture" },
      requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }), requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1 }),
  });
}
