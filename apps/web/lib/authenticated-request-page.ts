import "server-only";

import { notFound, redirect } from "next/navigation";
import type { WorkspaceCapability } from "@narriflow/validators";
import {
  authenticatedRequestPolicy,
  signedInAuthenticatedRequestPolicy,
} from "./authenticated-request-policy.server";
import type {
  AuthenticatedRequestAdmission,
  AuthenticatedRequestFailureValue,
} from "./authenticated-request-policy";
import { AuthenticatedRequestUnexpectedError } from "./authenticated-request-policy";

function recoveryDestination(
  failure: AuthenticatedRequestFailureValue,
  projectId?: string,
  authenticationReturnTo?: string,
): never {
  if (failure.code === "authentication_required") {
    const returnTo =
      authenticationReturnTo ??
      (projectId ? `/projects/${projectId}` : "/home");
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
  }
  if (failure.code === "project_not_found") notFound();
  if (failure.code === "active_workspace_mismatch") {
    const workspaceId = String(failure.details?.workspaceId ?? "");
    const workspaceName = String(failure.details?.workspaceName ?? "Workspace");
    redirect(
      `/projects?requestFailure=active_workspace_mismatch&workspaceId=${encodeURIComponent(workspaceId)}&workspaceName=${encodeURIComponent(workspaceName)}&returnTo=${encodeURIComponent(projectId ? `/projects/${projectId}` : "/projects")}`,
    );
  }
  const destination =
    failure.code === "workspace_restricted" &&
    failure.details?.ownerCanResolve === true
      ? "/settings/billing"
      : "/home";
  redirect(
    `${destination}?requestFailure=${encodeURIComponent(failure.code)}&requestId=${encodeURIComponent(failure.requestId)}`,
  );
}

async function admitPage(
  admission: AuthenticatedRequestAdmission,
  policy = authenticatedRequestPolicy,
  authenticationReturnTo?: string,
) {
  let result;
  try {
    result = await policy.execute({
      adapter: "page",
      operationName:
        admission.kind === "project"
          ? "admit-project-page"
          : admission.kind === "signed_in"
            ? "admit-signed-in-page"
            : "admit-workspace-page",
      admission,
      operation: async ({ actor }) => actor,
    });
  } catch (error) {
    if (error instanceof AuthenticatedRequestUnexpectedError) {
      console.warn(
        JSON.stringify({
          level: "error",
          message: "authenticated_request_unexpected_failure",
          adapter: "page",
          requestId: error.requestId,
        }),
      );
    }
    throw error;
  }
  return result.ok
    ? result.value
    : recoveryDestination(
        result.failure,
        admission.kind === "project" ? admission.projectId : undefined,
        authenticationReturnTo,
      );
}

export function admitSignedInPage(authenticationReturnTo = "/home") {
  return admitPage(
    { kind: "signed_in" },
    signedInAuthenticatedRequestPolicy,
    authenticationReturnTo,
  );
}

export function admitWorkspacePage(
  capability: WorkspaceCapability,
) {
  return admitPage({ kind: "workspace", capability });
}

export function admitProjectPage(
  projectId: string,
  capability: WorkspaceCapability,
) {
  return admitPage({ kind: "project", capability, projectId });
}

export async function admitOptionalWorkspacePage(
  capability: WorkspaceCapability,
) {
  const result = await authenticatedRequestPolicy.execute({
    adapter: "page",
    operationName: "admit-optional-workspace-page",
    admission: { kind: "workspace", capability },
    operation: async ({ actor }) => actor,
  });
  if (result.ok) return result.value;
  if (result.failure.code === "authentication_required") return null;
  return recoveryDestination(result.failure);
}
