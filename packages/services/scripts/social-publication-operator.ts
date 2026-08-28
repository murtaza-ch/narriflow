import { socialPublicationRecovery } from "../src/social-publication-recovery";
import { parseSocialPublicationOperatorArgs } from "../src/social-publication-operator";

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const input = parseSocialPublicationOperatorArgs(process.argv.slice(2));
  const before = await socialPublicationRecovery.inspect(input);
  if (!input.recheck) {
    write({ mode: "inspect", inspection: before });
  } else {
    const reconciliation = await socialPublicationRecovery.recheck({
      ...input,
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
    const after = await socialPublicationRecovery.inspect(input);
    write({ mode: "recheck", reconciliation, before, after });
  }
} catch (error) {
  write({
    mode: "failed",
    error:
      error instanceof Error && "code" in error
        ? String(error.code)
        : "social_publication_operator_failed",
  });
  process.exitCode = 1;
}
