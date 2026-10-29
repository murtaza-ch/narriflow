export interface ConnectionLimits {
  maxConnections: number;
  maxConnectionsPerActor: number;
}

export type ConnectionRefusal = "capacity" | "actor_limit";

/**
 * Bounds open streams per process and per actor. `admit` returns a release
 * function (idempotent) or the reason for refusing.
 */
export function createConnectionRegistry(limits: ConnectionLimits) {
  let total = 0;
  const perActor = new Map<string, number>();
  return {
    admit(actorUserId: string): { release(): void } | { refused: ConnectionRefusal } {
      if (total >= limits.maxConnections) return { refused: "capacity" };
      const held = perActor.get(actorUserId) ?? 0;
      if (held >= limits.maxConnectionsPerActor) return { refused: "actor_limit" };
      total += 1;
      perActor.set(actorUserId, held + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const remaining = (perActor.get(actorUserId) ?? 1) - 1;
          if (remaining <= 0) perActor.delete(actorUserId);
          else perActor.set(actorUserId, remaining);
        },
      };
    },
    /** Open streams now, for tests and diagnostics. */
    get open() {
      return total;
    },
  };
}
