/**
 * Image build check: start the YouTube token provider exactly as the worker
 * does, against the provider files this image actually contains. A launch that
 * cannot work here fails the build instead of disabling YouTube intake at runtime.
 */
import { startYoutubeTokenServer } from "../src/youtube-import";
import { WorkerProcessFailure } from "../src/worker-process";

const home = process.env.YTDLP_POT_SERVER_HOME ?? "/opt/youtube-tokens";
try {
  const server = await startYoutubeTokenServer(home, new AbortController().signal);
  server.stop();
  await server.exited;
  console.log("YouTube token provider starts in this image");
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof WorkerProcessFailure
      ? `${error.code} (exit ${error.exitCode}): ${error.diagnostic}`
      : error,
  );
  process.exit(1);
}
