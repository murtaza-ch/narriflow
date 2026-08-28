export interface WorkspaceBillingOperatorArgs {
  workspaceId: string;
  reconcile: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkspaceBillingOperatorArgs(
  args: string[],
): WorkspaceBillingOperatorArgs {
  let workspaceId: string | null = null;
  let reconcile = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workspace") {
      workspaceId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--reconcile") {
      reconcile = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!workspaceId || !UUID.test(workspaceId)) {
    throw new Error("--workspace must be a valid Workspace UUID");
  }
  return { workspaceId, reconcile };
}
