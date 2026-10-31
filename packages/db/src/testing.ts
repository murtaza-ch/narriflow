import type { PrismaClient } from "@prisma/client";
import { createDatabaseScope, withDatabaseScope } from "./client";

/** A fixture owns its client until afterAll. Each callback gets its own scope.
 * A mutable, test-local client permits the existing Prisma fault extensions. */
export function createDatabaseTestContext() {
  const context = {
    client: undefined as PrismaClient | undefined,
    bind<Args extends unknown[], Result>(callback: (...args: Args) => Result | Promise<Result>) {
      return (...args: Args): Promise<Result> => withDatabaseScope(
        createDatabaseScope({
          createClient: () => ({
            get client() {
              if (!context.client) throw new Error("Test database client is unavailable");
              return context.client;
            },
            dispose: async () => {},
          }),
        }),
        () => callback(...args),
      );
    },
  };
  return context;
}
