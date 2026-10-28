export const USER = "user_2abc";
export const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

export function errorResponse(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    { error, message: `message for ${error}`, requestId: "req_1", ...extra },
    { status, headers },
  );
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

/** A fetch double that records calls and answers from a queue of handlers. */
export function fakeFetch(
  ...handlers: Array<(call: RecordedCall) => Response | Promise<Response>>
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      init,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (!handler) throw new Error("no handler");
    const signal = init.signal;
    const result = handler(call);
    if (!signal) return result;
    return Promise.race([
      Promise.resolve(result),
      new Promise<Response>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
