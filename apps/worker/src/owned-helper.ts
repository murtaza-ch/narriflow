import process from "node:process";
import { pathToFileURL } from "node:url";

// The worker owns stdin's write end. EOF also arrives on a hard restart or
// SIGKILL, when the worker cannot run its normal shutdown handlers.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
const entrypoint = process.argv.splice(2, 1)[0];
if (!entrypoint) throw new Error("Missing helper entrypoint");
await import(pathToFileURL(entrypoint).href);
