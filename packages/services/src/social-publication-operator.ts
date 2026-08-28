export interface SocialPublicationOperatorArgs {
  workspaceId: string;
  socialPostId: string;
  recheck: false;
}

export interface SocialPublicationRecheckOperatorArgs {
  workspaceId: string;
  socialPostId: string;
  recheck: true;
  actorUserId: string;
  reason: string;
}

export type ParsedSocialPublicationOperatorArgs =
  | SocialPublicationOperatorArgs
  | SocialPublicationRecheckOperatorArgs;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSocialPublicationOperatorArgs(
  args: string[],
): ParsedSocialPublicationOperatorArgs {
  let workspaceId: string | null = null;
  let socialPostId: string | null = null;
  let actorUserId: string | null = null;
  let reason: string | null = null;
  let recheck = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workspace") {
      workspaceId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--post") {
      socialPostId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--actor") {
      actorUserId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--reason") {
      reason = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--recheck") {
      recheck = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!workspaceId || !UUID.test(workspaceId)) {
    throw new Error("--workspace must be a valid Workspace UUID");
  }
  if (!socialPostId || !UUID.test(socialPostId)) {
    throw new Error("--post must be a valid Social Post UUID");
  }
  if (!recheck) return { workspaceId, socialPostId, recheck: false };
  if (!actorUserId || !UUID.test(actorUserId)) {
    throw new Error("--actor must be a valid User UUID for --recheck");
  }
  const normalizedReason = reason?.trim() ?? "";
  if (normalizedReason.length < 1 || normalizedReason.length > 500) {
    throw new Error("--reason must contain 1 to 500 characters for --recheck");
  }
  return {
    workspaceId,
    socialPostId,
    recheck: true,
    actorUserId,
    reason: normalizedReason,
  };
}
