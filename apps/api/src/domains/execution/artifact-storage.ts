import { createHash } from "node:crypto";
import type { ExecutionArtifact } from "@prisma/client";
import { ExecutorControlError, type ExecutorArtifactHead } from "@narriflow/services/executor-control";
import type { ExecutorArtifactCommit } from "@narriflow/services/executor-domain-control";

const invalid = (): never => { throw new ExecutorControlError("artifact_invalid"); };
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");

/** Worker binding adapter. Reads only the already assigned object and keeps
 * bounded probe bytes outside the domain mutation transaction. */
export function createAssignedArtifactStorage(bucket: R2Bucket) {
  async function readBytes(artifact:ExecutorArtifactCommit,maxBytes:number){
      const object = await bucket.get(artifact.storageKey, { onlyIf: new Headers({ "If-Match": artifact.etag }), range: { offset: 0, length: maxBytes + 1 } });
      if (!object || !("body" in object)) return invalid();
      if (object.key !== artifact.storageKey || object.httpEtag !== artifact.etag || BigInt(object.size) !== artifact.byteLength ||
        object.httpMetadata?.contentType !== artifact.contentType || object.customMetadata?.["execution-artifact-id"] !== artifact.artifactId ||
        object.customMetadata?.["execution-binding-hash"] !== artifact.bindingHash) {
        await object.body.cancel(); return invalid();
      }
      const reader = object.body.getReader(),bytes=new Uint8Array(Number(artifact.byteLength)),digest=createHash("sha256");
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxBytes) { await reader.cancel(); return invalid(); }
          if(length>bytes.byteLength){await reader.cancel();return invalid();}
          bytes.set(part.value,length-part.value.byteLength);digest.update(part.value);
        }
      } finally { reader.releaseLock(); }
      if (BigInt(length) !== artifact.byteLength) return invalid();
      if(digest.digest("hex")!==artifact.sha256)return invalid();
      return bytes;
  }
  return {
    async head(assignment: Readonly<ExecutionArtifact>): Promise<ExecutorArtifactHead | null> {
      const object = await bucket.head(assignment.storageKey);
      if (!object) return null;
      if (object.key !== assignment.storageKey || object.customMetadata?.["execution-artifact-id"] !== assignment.id ||
        object.customMetadata?.["execution-binding-hash"] !== assignment.bindingHash || !object.httpMetadata?.contentType) return invalid();
      return { etag: object.httpEtag, contentType: object.httpMetadata.contentType, byteLength: BigInt(object.size),
        ...(object.checksums.sha256 ? { sha256: hex(object.checksums.sha256) } : {}) };
    },
    async readBytes(artifact:ExecutorArtifactCommit,maxBytes:number):Promise<Uint8Array>{
      if(artifact.role!=="publication_checkpoint"||artifact.contentType!=="application/octet-stream"||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024**2||artifact.byteLength<1n||artifact.byteLength>BigInt(maxBytes))return invalid();
      return readBytes(artifact,maxBytes);
    },
    async readJson(artifact:ExecutorArtifactCommit,maxBytes:number):Promise<unknown>{
      const roleLimit=artifact.role==="outbound_receipt"?4*1024**2:artifact.role==="layout_evidence"?1024**2:65536;
      if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>roleLimit||artifact.byteLength>BigInt(maxBytes)||artifact.contentType!=="application/json")return invalid();
      const bytes=await readBytes(artifact,maxBytes);
      try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return invalid();}
    },
  };
}
