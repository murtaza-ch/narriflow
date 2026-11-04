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

/**
 * `uuidParams` for a route that also has segments the handler validates itself
 * (a format name): they stay in the route's typed params for the client.
 */
export function pathParams<const Uuids extends readonly string[], const Free extends readonly string[]>(
  uuids: Uuids,
  ...free: Free
) {
  const shape = {
    ...Object.fromEntries(uuids.map((name) => [name, z.string().uuid()])),
    ...Object.fromEntries(free.map((name) => [name, z.string()])),
  } as Record<Uuids[number], z.ZodString> & Record<Free[number], z.ZodString>;
  return validate("param", z.object(shape));
}
