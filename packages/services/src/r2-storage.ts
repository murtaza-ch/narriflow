import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getR2Config() {
  return {
    accountId: getRequiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: getRequiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: getRequiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: getRequiredEnv("R2_BUCKET"),
  };
}

let r2Client: S3Client | null = null;

function getClient() {
  if (r2Client) {
    return r2Client;
  }

  const { accountId, accessKeyId, secretAccessKey } = getR2Config();

  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2Client;
}

export function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

export async function createMultipartUpload(params: {
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
      Metadata: params.metadata,
    }),
  );

  if (!response.UploadId) {
    throw new Error("R2 multipart upload did not return upload id");
  }

  return { uploadId: response.UploadId };
}

export async function presignMultipartPartUrls(params: {
  key: string;
  uploadId: string;
  partNumbers: number[];
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  const uploadUrls = await Promise.all(
    params.partNumbers.map(async (partNumber) => {
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: params.key,
          PartNumber: partNumber,
          UploadId: params.uploadId,
        }),
        {
          expiresIn: SIGNED_URL_TTL_SECONDS,
        },
      );

      return {
        partNumber,
        url,
      };
    }),
  );

  return uploadUrls;
}

export async function listUploadedParts(params: {
  key: string;
  uploadId: string;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new ListPartsCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );

  return (response.Parts ?? [])
    .map((part) => ({
      partNumber: part.PartNumber ?? 0,
      etag: part.ETag ?? "",
    }))
    .filter((part) => part.partNumber > 0 && part.etag);
}

export async function completeMultipartUpload(params: {
  key: string;
  uploadId: string;
  etags: Array<{ partNumber: number; etag: string }>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: params.etags
          .slice()
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
      },
    }),
  );
}

export async function abortMultipartUpload(params: {
  key: string;
  uploadId: string;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );
}

export async function headObject(key: string) {
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return {
    contentType: response.ContentType ?? null,
    sizeBytes: response.ContentLength ?? null,
    etag: response.ETag ?? null,
  };
}

export async function putFileFromPath(params: {
  key: string;
  filePath: string;
  contentType?: string;
  metadata?: Record<string, string>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: readFileSync(params.filePath),
      ContentType: params.contentType,
      Metadata: params.metadata,
    }),
  );

  return {
    key: params.key,
    fileName: basename(params.filePath),
  };
}

export async function downloadObjectToFile(params: {
  key: string;
  filePath: string;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
    }),
  );

  if (!response.Body) {
    throw new Error(`R2 object body missing for key: ${params.key}`);
  }

  const body = response.Body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
  };

  if (!body.transformToWebStream) {
    throw new Error("R2 response body cannot be streamed");
  }

  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");

  await pipeline(
    Readable.fromWeb(
      body.transformToWebStream() as unknown as import("node:stream/web").ReadableStream,
    ),
    createWriteStream(params.filePath),
  );

  return {
    key: params.key,
    contentType: response.ContentType ?? null,
  };
}

export async function presignDownloadUrl(params: {
  key: string;
  expiresIn?: number;
  fileName?: string;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ...(params.fileName && {
        ResponseContentDisposition: `attachment; filename="${params.fileName}"`,
      }),
    }),
    { expiresIn: params.expiresIn ?? 3600 },
  );
}

export async function presignSingleUploadUrl(params: {
  key: string;
  contentType: string;
  expiresIn?: number;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
    { expiresIn: params.expiresIn ?? SIGNED_URL_TTL_SECONDS },
  );
}

export async function deleteObject(key: string) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return { key };
}

export async function putJson(params: {
  key: string;
  value: unknown;
  metadata?: Record<string, string>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: JSON.stringify(params.value, null, 2),
      ContentType: "application/json",
      Metadata: params.metadata,
    }),
  );

  return { key: params.key };
}
