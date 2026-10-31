import { progressTicketPayloadSchema, PROGRESS_CONNECT_TICKET_MS, PROGRESS_SUBSCRIPTION_MAX_MS, type ProgressTicketPayload } from "@narriflow/validators/api/progress";

export interface ProgressTicketKeys {
  activeKeyId: string;
  keys: Readonly<Record<string, Uint8Array>>;
}
export class InvalidProgressTicket extends Error {
  constructor() { super("invalid_progress_ticket"); this.name = "InvalidProgressTicket"; }
}
const KEY_ID = /^[A-Za-z0-9_-]{1,40}$/;
function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decoded(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidProgressTicket();
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
  if (encoded(bytes) !== value) throw new InvalidProgressTicket();
  return bytes;
}
function source(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }

export function loadProgressTicketKeys(environment: Readonly<Record<string, string | undefined>>): ProgressTicketKeys {
  try {
    const activeKeyId = environment.PROGRESS_CONNECT_KEY_ID ?? "";
    const raw = environment.PROGRESS_CONNECT_KEYS_JSON ?? "";
    if (raw.length > 4_096 || !KEY_ID.test(activeKeyId)) throw new Error();
    const values: unknown = JSON.parse(raw);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
    const entries = Object.entries(values);
    if (entries.length < 1 || entries.length > 4) throw new Error();
    const keys: Record<string, Uint8Array> = {};
    for (const [id, secret] of entries) {
      if (!KEY_ID.test(id) || typeof secret !== "string") throw new Error();
      const bytes = decoded(secret.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_"));
      if (bytes.byteLength < 32 || bytes.byteLength > 64) throw new Error();
      keys[id] = bytes;
    }
    if (!keys[activeKeyId]) throw new Error();
    return { activeKeyId, keys };
  } catch {
    throw new Error("Progress ticket keys are not configured");
  }
}

export function createProgressTicketCodec(configuration: ProgressTicketKeys) {
  const key = async (id: string) => {
    const bytes = configuration.keys[id];
    if (!KEY_ID.test(id) || !bytes || bytes.byteLength < 32) throw new InvalidProgressTicket();
    return crypto.subtle.importKey("raw", source(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  };
  return {
    async issue(scope: Pick<ProgressTicketPayload, "actorUserId" | "workspaceId" | "projectId" | "origin" | "audience">, authorizedAt: number): Promise<string> {
      const payload = progressTicketPayloadSchema.parse({ ...scope, version: 1, authorizedAt,
        ticketExpiresAt: authorizedAt + PROGRESS_CONNECT_TICKET_MS, subscriptionExpiresAt: authorizedAt + PROGRESS_SUBSCRIPTION_MAX_MS,
        nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("") });
      const input = `progress1.${configuration.activeKeyId}.${encoded(new TextEncoder().encode(JSON.stringify(payload)))}`;
      const signature = await crypto.subtle.sign("HMAC", await key(configuration.activeKeyId), new TextEncoder().encode(input));
      return `${input}.${encoded(new Uint8Array(signature))}`;
    },
    async verify(ticket: string, input: { audience: string; origin: string; nowMs: number }): Promise<ProgressTicketPayload> {
      try {
        if (ticket.length > 4_096) throw new InvalidProgressTicket();
        const [version, id, body, signature, extra] = ticket.split(".");
        if (version !== "progress1" || !id || !body || !signature || extra !== undefined) throw new InvalidProgressTicket();
        const valid = await crypto.subtle.verify("HMAC", await key(id), source(decoded(signature)), new TextEncoder().encode(`${version}.${id}.${body}`));
        if (!valid) throw new InvalidProgressTicket();
        const payload = progressTicketPayloadSchema.parse(JSON.parse(new TextDecoder().decode(decoded(body))));
        if (payload.audience !== input.audience || payload.origin !== input.origin ||
          input.nowMs < payload.authorizedAt - 5_000 || input.nowMs >= payload.ticketExpiresAt || input.nowMs >= payload.subscriptionExpiresAt) throw new InvalidProgressTicket();
        return payload;
      } catch { throw new InvalidProgressTicket(); }
    },
  };
}
