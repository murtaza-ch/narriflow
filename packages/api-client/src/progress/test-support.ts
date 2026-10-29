import type { ApiTransport } from "../core";

/** A transport the hub tests never call (they replace `runStream`). */
export function fakeTransport(): ApiTransport {
  const bound = {
    baseUrl: "http://localhost:4000",
    fetch: async () => {
      throw new Error("not used");
    },
    json: async () => {
      throw new Error("not used");
    },
    open: async () => {
      throw new Error("not used");
    },
  };
  return { baseUrl: "http://localhost:4000", scoped: () => bound, identity: () => bound } as unknown as ApiTransport;
}
