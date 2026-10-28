import { z } from "zod";
import { validate } from "../../http/route";

/**
 * Path-parameter guard: each named parameter must be a UUID, checked after
 * admission and before the handler. Parameters not named here pass through
 * untouched (the service validates them).
 */
export function uuidParams<const Names extends readonly string[]>(...names: Names) {
  const shape = Object.fromEntries(names.map((name) => [name, z.string().uuid()])) as Record<
    Names[number],
    z.ZodString
  >;
  return validate("param", z.object(shape));
}
