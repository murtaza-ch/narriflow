export type BoundedBody = { kind: "ok"; bytes: Uint8Array<ArrayBuffer> } | { kind: "too_large" };

/**
 * Reads a body once, counting bytes as they stream: a lying or absent
 * Content-Length cannot make the caller buffer more than `maxBytes` plus one
 * chunk. The stream is cancelled the moment it passes the limit. A read error
 * propagates.
 */
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BoundedBody> {
  if (!body) return { kind: "ok", bytes: new Uint8Array() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        // Not awaited: an upstream that never settles its cancel must not hold the answer.
        void reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}
