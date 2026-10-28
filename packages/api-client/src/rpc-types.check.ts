/**
 * Compile-time proof that Hono's RPC inference survives the domain split: a
 * real read (Project snapshot) and a real mutation (start generation) keep
 * their input and per-status output types through `import type` alone. This
 * file is type-checked, never executed.
 */
import type { GenerateProjectInput } from "@narriflow/validators";
import type { ProjectsClient } from "./projects";
import type { BrandClient } from "./brand";

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

export async function brandInference(client: BrandClient) {
  const read = await client["brand-templates"][":id"].$get({ param: { id: "template" } });
  const template = await read.json();
  const id: string = template.id;
  // @ts-expect-error the read response must not widen to any
  const wrongId: number = template.id;
  const created = await client["brand-templates"].$post({
    json: { name: "Review", captionPreset: {} },
  });
  const createdId: string = (await created.json()).id;
  // @ts-expect-error the shared mutation schema requires a string name
  await client["brand-templates"].$post({ json: { name: 1, captionPreset: {} } });
  return { id, createdId, wrongId };
}
