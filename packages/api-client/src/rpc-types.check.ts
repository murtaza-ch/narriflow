/**
 * Compile-time proof that Hono's RPC inference survives the domain split: a
 * real read (Project snapshot) and a real mutation (start generation) keep
 * their input and per-status output types through `import type` alone. This
 * file is type-checked, never executed.
 */
import type { GenerateProjectInput } from "@narriflow/validators";
import type { ProjectsClient } from "./projects";

export async function projectsReadInference(client: ProjectsClient) {
  const response = await client.projects[":id"].$get({ param: { id: "p" } });
  if (response.status === 404) {
    const body = await response.json();
    const code: string = body.error;
    return code;
  }
  const snapshot = await response.json();
  return snapshot.lastSeq;
}

export async function projectsMutationInference(client: ProjectsClient, input: GenerateProjectInput) {
  const accepted = await client.projects[":id"].generate.$post({
    param: { id: "p" },
    json: input,
  });
  // The accepted response is the generation result; other statuses are not the 202 body.
  if (accepted.status === 202) return (await accepted.json()).workflowRunId;

  // @ts-expect-error `param` is required by the route path
  await client.projects[":id"].generate.$post({ json: input });
  // @ts-expect-error a wrongly typed field is refused by the shared schema type
  await client.projects[":id"].generate.$post({ param: { id: "p" }, json: { forceRegenerate: 1 } });
  return null;
}
