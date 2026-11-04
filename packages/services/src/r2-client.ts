import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface R2ClientCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The one place an R2 client is built. */
export function createR2Client(
  credentials: R2ClientCredentials,
  extra: Pick<S3ClientConfig, "requestHandler" | "maxAttempts" | "responseChecksumValidation"> = {},
): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    ...extra,
    // The SDK's default ("WHEN_SUPPORTED") attaches a request checksum to
    // every request whose operation supports one — including PutObject/
    // UploadPart — by wrapping the body in `aws-chunked` trailer framing.
    // R2 rejects that framing outright, which is the actual root cause behind
    // both errors this file used to hit when streaming a body ("You did not
    // provide the number of bytes specified by the Content-Length HTTP
    // header" on single PUT; "The socket connection was closed unexpectedly"
    // on multipart). "WHEN_REQUIRED" only computes a checksum when the
    // operation mandates one (S3/R2's PutObject and UploadPart do not), so
    // the body goes out exactly as given — no forced chunked framing.
    // Verified against the real bucket at 1.5 MB and 50 MB with this set.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}
