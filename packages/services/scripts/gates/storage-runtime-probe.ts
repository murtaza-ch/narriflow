import { S3Client } from "@aws-sdk/client-s3";
import { createExecutionStorage } from "../../src/execution-storage";

const config = { accountId: "a".repeat(32), bucket: "private-bucket", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
const object = { artifactId: "00000000-0000-4000-8000-000000000001", storageKey: "execution/1/token/owner/source",
  bindingHash: "b".repeat(64), contentType: "video/mp4", byteLength: 3 };
const md5 = "kAFQmDzST7DWlj99KOF/cg==";
const checksum = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
export default {
  async fetch() {
    const checks: string[] = [], methods: string[] = [];
    let failComplete = false;
    const client = new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { async handle(input: unknown) {
        const request = input as { method: string; query: Record<string, string> };
        methods.push(request.method);
        let xml = "";
        const headers: Record<string, string> = { "content-type": "application/xml" };
        if (request.method === "POST" && "uploads" in request.query) xml = "<InitiateMultipartUploadResult><UploadId>assigned-upload</UploadId></InitiateMultipartUploadResult>";
        else if (request.method === "GET") xml = `<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>900150983cd24fb0d6963f7d28e17f72</ETag><Size>3</Size></Part><IsTruncated>false</IsTruncated></ListPartsResult>`;
        else if (request.method === "POST") xml = failComplete ? "<Error><Code>InvalidPart</Code><Message>fixture failure</Message></Error>" : "<CompleteMultipartUploadResult><ETag>final-etag</ETag></CompleteMultipartUploadResult>";
        else if (request.method === "HEAD") Object.assign(headers, { "content-length": "3", "content-type": object.contentType,
          etag: "final-etag", "x-amz-meta-execution-artifact-id": object.artifactId, "x-amz-meta-execution-binding-hash": object.bindingHash });
        return { response: { statusCode: 200, headers, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(xml)); controller.close(); } }) } };
      } },
    });
    const storage = createExecutionStorage(config, { client });
    function check(ok: boolean, name: string) { if (!ok) throw new Error(name); checks.push(name); }
    try {
      const assignment = await storage.create(object);
      check(assignment.uploadId === "assigned-upload", "create_multipart");
      const window = { leaseExpiresAt: new Date(Date.now() + 90_000), operationDeadlineAt: new Date(Date.now() + 2_700_000) };
      const upload = await storage.signPart(assignment, { ...window, partNumber: 1, byteLength: 3, checksumSha256: checksum, checksumMd5: md5 });
      check(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders") === "content-length;content-md5;host", "sigv4_part_checksum_and_length");
      const range = await storage.signSourceRange(assignment, { storageKey: "uploads/verified", etag: '"source"', byteLength: 3 }, { ...window, start: 0, end: 3 });
      check(new URL(range.url).searchParams.get("X-Amz-SignedHeaders") === "host;if-match;range", "sigv4_exact_source_condition");
      const receipts = [{ partNumber: 1, etag: "900150983cd24fb0d6963f7d28e17f72", checksumSha256: checksum, checksumMd5: md5 }];
      const completed = await storage.complete(assignment, receipts);
      check(completed.byteLength === 3 && completed.etag === "final-etag", "complete_then_exact_head");
      failComplete = true;
      let code = "";
      try { await storage.complete(assignment, receipts); } catch (error) { code = error instanceof Error ? error.message : ""; }
      check(code === "storage_completion_unconfirmed", "embedded_http200_error_keeps_uncertain_object");
      check(!methods.includes("DELETE"), "no_abort_after_ambiguous_complete");
      return Response.json({ runtime: "workerd", checks, passed: checks.length, provider: "injected_s3_transport" });
    } finally { client.destroy(); }
  },
};
