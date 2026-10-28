import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { McpConfirmationInput } from "@narriflow/validators/api/integrations";
import { type ApiError, type ApiTransport, type IdentityScope, type WorkspaceScope, invalidateScoped } from "../core";
import { createIntegrationsClient } from "./client";

/** The signed publication carries its native acceptance identity. */
export function mcpConfirmationMutationOptions(input: { transport: ApiTransport; scope: IdentityScope }) {
  const client = createIntegrationsClient(input.transport.identity(input.scope));
  return mutationOptions<{ destination: string }, ApiError, McpConfirmationInput>({
    mutationFn: async (json) => (await client.mcp.confirmations.$post({ json })).json(),
    retry: false,
  });
}

export function invalidateAfterMcpConfirmation(queryClient: QueryClient, scope: WorkspaceScope) {
  return invalidateScoped(queryClient, scope, "publishing");
}
