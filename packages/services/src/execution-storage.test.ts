import { expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { createExecutionStorage } from "./execution-storage";

const object = {
  artifactId: "00000000-0000-4000-8000-000000000001", storageKey: "execution/1/token/owner/source",
  bindingHash: "b".repeat(64), contentType: "video/mp4", byteLength: 10 * 1024 ** 3,
};
const assignment = { ...object, uploadId: "assigned-upload", partSizeBytes: 16 * 1024 * 1024 };
const config = { accountId: "a".repeat(32), bucket: "private-bucket", accessKeyId: "test-access", secretAccessKey: "test-secret" };

test("executor UploadPart grants bind length, checksum and the current lease", async () => {
  const now = new Date("2026-10-31T00:00:00.000Z");
  const storage = createExecutionStorage(config, { now: () => now });
  const grant = await storage.signPart(assignment, { partNumber: 1, byteLength: 16 * 1024 * 1024,
    checksumSha256: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", checksumMd5: "kAFQmDzST7DWlj99KOF/cg==",
    leaseExpiresAt: new Date(now.getTime() + 90_000), operationDeadlineAt: new Date(now.getTime() + 60_000) });
  const url = new URL(grant.url);
  expect(url.searchParams.get("uploadId")).toBe("assigned-upload");
  expect(url.searchParams.get("partNumber")).toBe("1");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
  expect(url.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-md5;host");
  expect(grant.headers).toEqual({ "Content-Length": "16777216", "Content-MD5": "kAFQmDzST7DWlj99KOF/cg==" });
  storage.close();
});

test("pin grants sign the exact original ETag and bounded range, and expired or misaligned requests fail", async () => {
  const now = new Date("2026-10-31T00:00:00.000Z");
  const storage = createExecutionStorage(config, { now: () => now });
  const window = { leaseExpiresAt: new Date(now.getTime() + 120_000), operationDeadlineAt: new Date(now.getTime() + 2_700_000) };
  const grant = await storage.signSourceRange(assignment, { storageKey: "uploads/verified/source", etag: '"original"', byteLength: object.byteLength },
    { ...window, start: 16 * 1024 * 1024, end: 32 * 1024 * 1024 });
  expect(new URL(grant.url).searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-match;range");
  expect(grant.headers).toEqual({ "If-Match": '"original"', Range: "bytes=16777216-33554431" });
  await expect(storage.signSourceRange(assignment, { storageKey: "uploads/verified/source", etag: '"original"', byteLength: object.byteLength },
    { ...window, start: 1, end: 100 })).rejects.toMatchObject({ code: "storage_parts_invalid" });
  await expect(storage.signPart(assignment, { ...window, leaseExpiresAt: now, partNumber: 1, byteLength: 16 * 1024 * 1024,
    checksumSha256: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", checksumMd5: "kAFQmDzST7DWlj99KOF/cg==" })).rejects.toMatchObject({ code: "storage_grant_expired" });
  storage.close();
});


type WireRequest = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown };
function fixtureClient(handle: (request: WireRequest) => { status?: number; headers?: Record<string, string>; xml?: string }) {
  return new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { async handle(request: unknown) {
      const output = handle(request as WireRequest);
      return { response: { statusCode: output.status ?? 200, headers: output.headers ?? { "content-type": "application/xml" },
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(output.xml ?? "")); controller.close(); } }) } };
    } },
  });
}
const smallObject = { ...object, byteLength: 3 };
const smallAssignment = { ...assignment, byteLength: 3 };
const partChecksum = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
const partMd5 = "kAFQmDzST7DWlj99KOF/cg==";
const partInventory = `<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>900150983cd24fb0d6963f7d28e17f72</ETag><Size>3</Size></Part><IsTruncated>false</IsTruncated></ListPartsResult>`;
const targetHeaders = { "content-length": "3", "content-type": "video/mp4", etag: "final-etag",
  "x-amz-meta-execution-artifact-id": smallObject.artifactId, "x-amz-meta-execution-binding-hash": smallObject.bindingHash };

test("concrete S3 control creates checksum MPU, verifies every listed receipt, completes and HEADs exact assigned metadata", async () => {
  const requests: WireRequest[] = [];
  const client = fixtureClient(request => {
    requests.push(request);
    if (request.method === "POST" && "uploads" in request.query) return { xml: "<InitiateMultipartUploadResult><UploadId>assigned-upload</UploadId></InitiateMultipartUploadResult>" };
    if (request.method === "GET") return { xml: partInventory };
    if (request.method === "POST") return { xml: "<CompleteMultipartUploadResult><ETag>final-etag</ETag></CompleteMultipartUploadResult>" };
    if (request.method === "HEAD") return { headers: targetHeaders };
    throw new Error("unexpected fixture request");
  });
  const storage = createExecutionStorage(config, { client });
  const created = await storage.create(smallObject);
  expect(created).toEqual(smallAssignment);
  expect(requests[0]?.headers["x-amz-checksum-algorithm"]).toBeUndefined();
  expect(requests[0]?.headers["x-amz-checksum-type"]).toBeUndefined();
  expect(await storage.complete(created, [{ partNumber: 1, etag: "900150983cd24fb0d6963f7d28e17f72", checksumSha256: partChecksum, checksumMd5: partMd5 }])).toEqual({
    key: smallObject.storageKey, etag: "final-etag", byteLength: 3, contentType: "video/mp4",
  });
  expect(requests.map(request => request.method)).toEqual(["POST", "GET", "POST", "HEAD"]);
  expect(String(requests[2]?.body)).not.toContain("ChecksumSHA256");
  client.destroy();
});

test("missing provider part checksums refuse completion and embedded HTTP 200 errors stay uncertain without abort", async () => {
  for (const missingChecksum of [true, false]) {
    const methods: string[] = [];
    const client = fixtureClient(request => {
      methods.push(request.method);
      if (request.method === "GET") return { xml: missingChecksum ? partInventory.replace("900150983cd24fb0d6963f7d28e17f72", "opaque-provider-etag") : partInventory };
      return { xml: "<Error><Code>InvalidPart</Code><Message>private storage diagnostic</Message></Error>" };
    });
    const storage = createExecutionStorage(config, { client });
    await expect(storage.complete(smallAssignment, [{ partNumber: 1, etag: "900150983cd24fb0d6963f7d28e17f72", checksumSha256: partChecksum, checksumMd5: partMd5 }])).rejects.toMatchObject({
      code: missingChecksum ? "storage_part_checksum_unavailable" : "storage_completion_unconfirmed",
    });
    expect(methods).toEqual(missingChecksum ? ["GET"] : ["GET", "POST"]);
    client.destroy();
  }
});

test("completion HEAD rejects changed identity and exact-key recovery excludes prefixed neighbours", async () => {
  let changed = true;
  const client = fixtureClient(request => request.method === "HEAD" ? { headers: { ...targetHeaders, "content-length": changed ? "4" : "3" } } : { xml:
    `<ListMultipartUploadsResult><Upload><Key>${object.storageKey}</Key><UploadId>exact-upload</UploadId><Initiated>2026-10-31T00:00:00Z</Initiated></Upload>` +
    `<Upload><Key>${object.storageKey}-other</Key><UploadId>other-upload</UploadId><Initiated>2026-10-30T00:00:00Z</Initiated></Upload><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>` });
  const storage = createExecutionStorage(config, { client });
  await expect(storage.head(smallObject)).rejects.toMatchObject({ code: "storage_completion_unconfirmed" });
  changed = false;
  expect(await storage.head(smallObject)).toMatchObject({ byteLength: 3 });
  expect(await storage.findUnfinished(object.storageKey)).toEqual([{ uploadId: "exact-upload", initiatedAt: new Date("2026-10-31T00:00:00Z") }]);
  client.destroy();
});

test("small copies preserve If-Match and large objects cannot enter CopyObject", async () => {
  const requests: WireRequest[] = [];
  const client = fixtureClient(request => {
    requests.push(request);
    return request.method === "HEAD" ? { headers: targetHeaders } : { xml: "<CopyObjectResult><ETag>final-etag</ETag></CopyObjectResult>" };
  });
  const storage = createExecutionStorage(config, { client });
  expect(await storage.copySmall(smallObject, { storageKey: "uploads/verified/source", etag: '"original"', byteLength: 3 })).toMatchObject({ byteLength: 3 });
  expect(requests[0]?.headers["x-amz-copy-source-if-match"]).toBe('"original"');
  expect(requests[0]?.headers["x-amz-copy-source"]).toBe("private-bucket/uploads/verified/source");
  await expect(storage.copySmall(object, { storageKey: "uploads/verified/source", etag: '"original"', byteLength: object.byteLength })).rejects.toMatchObject({ code: "storage_assignment_invalid" });
  expect(requests.map(request => request.method)).toEqual(["PUT", "HEAD"]);
  client.destroy();
});

test("abort suppresses only exact NoSuchUpload and changed part receipts never complete", async () => {
  const methods: string[] = [];
  let missing = "NoSuchUpload";
  const client = fixtureClient(request => {
    methods.push(request.method);
    return request.method === "DELETE" ? { status: 404, xml: `<Error><Code>${missing}</Code><Message>fixture</Message></Error>` } : { xml: partInventory };
  });
  const storage = createExecutionStorage(config, { client });
  await storage.abort(smallAssignment);
  missing = "NoSuchKey";
  await expect(storage.abort(smallAssignment)).rejects.toMatchObject({ code: "storage_object_missing" });
  await expect(storage.complete(smallAssignment, [{ partNumber: 1, etag: "changed", checksumSha256: partChecksum, checksumMd5: partMd5 }])).rejects.toMatchObject({ code: "storage_parts_invalid" });
  expect(methods).toEqual(["DELETE", "DELETE", "GET"]);
  client.destroy();
});
