import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { S3Client } from "@aws-sdk/client-s3";
import { createR2Client, type R2ClientCredentials } from "./r2-client";

/** Workers-safe: the fetch handler only, with checksums computed only when an operation requires one. */
export function createFetchR2Client(
  credentials: R2ClientCredentials,
  options: { requestTimeoutMs: number; maxAttempts: number },
): S3Client {
  return createR2Client(credentials, {
    requestHandler: new FetchHttpHandler({ requestTimeout: options.requestTimeoutMs }),
    maxAttempts: options.maxAttempts,
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
