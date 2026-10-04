import { parseSocialPublicationOperatorArgs } from "../src/social-publication-operator";
import { socialService } from "../src/social.service";

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const input = parseSocialPublicationOperatorArgs(process.argv.slice(2));
  const scope = { actorUserId: input.actorUserId, workspaceId: input.workspaceId };
  const before = await socialService.inspectPublication(
    scope,
    input.socialPostId,
  );
  if (!input.recheck) {
    write({ mode: "inspect", inspection: before });
  } else {
    const reconciliation = await socialService.recheckPublication(
      scope,
      input.socialPostId,
      { reason: input.reason },
    );
    const after = await socialService.inspectPublication(
      scope,
      input.socialPostId,
    );
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
