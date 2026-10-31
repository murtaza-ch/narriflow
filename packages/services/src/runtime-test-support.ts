import { withServiceEnvironment } from "./runtime-environment";

/** Tests supply the environment they control explicitly, just as a Worker
 * supplies its bindings. This is never imported by a production entrypoint. */
export function bindServiceTestEnvironment<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  return (...args: Args): Result => withServiceEnvironment(process.env, () => callback(...args));
}
