"use server";

import { revalidatePath } from "next/cache";
import { sendEmail } from "@narriflow/email";
import { workspaceMembershipService, workspaceService,
} from "@narriflow/services";
import {
  executeWorkspaceActionWithInput,
  authenticatedActionResultError,
} from "@/lib/authenticated-request-action";
import {
  workspaceApiKeyActionSchema,
  workspaceApiKeyReferenceActionSchema,
  workspaceInviteActionSchema,
  workspaceInviteReferenceActionSchema,
  workspaceMemberReferenceActionSchema,
  workspaceMemberRoleActionSchema,
  workspaceSettingsActionSchema,
} from "@narriflow/validators";

function inviteUrl(token: string) {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";
  return `${origin}/invite/${token}`;
}

async function deliverWorkspaceInvite(input: {
  id: string;
  email: string;
  token: string;
  workspaceName: string;
}) {
  const url = inviteUrl(input.token);
  const delivery = await sendEmail({
    to: input.email,
    subject: `Join ${input.workspaceName} on Narriflow`,
    text: [
      `You've been invited to join ${input.workspaceName} on Narriflow.`,
      "",
      `Accept invitation: ${url}`,
      "",
      "This invitation expires in seven days.",
    ].join("\n"),
    idempotencyKey: `workspace-invite/${input.id}`,
  });
  return { url, emailSent: delivery.sent };
}

export async function updateWorkspaceAction(formData: FormData) {
  const input = {
    name: String(formData.get("name") ?? ""),
    timezone: String(formData.get("timezone") ?? "UTC"),
  };
  return executeWorkspaceActionWithInput(
    "workspace.manage",
    input,
    workspaceSettingsActionSchema,
    async (appUser, parsedInput) => {
    await workspaceService.updateWorkspace(appUser.actorUserId, appUser.workspaceId, {
      name: parsedInput.name,
      timezone: parsedInput.timezone,
    },
    );
    revalidatePath("/", "layout");
    revalidatePath("/settings/workspace");
    },
  );
}

export async function inviteMemberAction(input: {
  email: string;
  role: "admin" | "editor" | "viewer";
}) {
  try {
    return await executeWorkspaceActionWithInput("members.invite", input, workspaceInviteActionSchema, async (appUser, parsedInput) => {
      try {
        const invite = await workspaceService.createInvite(
          appUser.actorUserId,
          appUser.workspaceId,
          parsedInput,
        );
        revalidatePath("/settings/members");
        const delivery = await deliverWorkspaceInvite({
          ...invite,
          workspaceName: appUser.workspace.workspaceName,
        });
        return { ok: true as const, inviteUrl: delivery.url, emailSent: delivery.emailSent,
        };
      } catch (error) {
        const failure = authenticatedActionResultError(error, "Invite failed");
        return { ok: false as const, error: failure.message,
          errorCode: failure.errorCode,
          requestId: failure.requestId,
        };
      }
    });
  } catch (error) {
    const failure = authenticatedActionResultError(error, "Invite failed");
    return { ok: false as const, error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
    };
  }
}

export async function resendInviteAction(inviteId: string) {
  try {
    return await executeWorkspaceActionWithInput("members.invite", { inviteId }, workspaceInviteReferenceActionSchema, async (appUser, parsedInput) => {
      try {
        const invite = await workspaceService.resendInvite(
          appUser.actorUserId,
          appUser.workspaceId,
          parsedInput.inviteId,
        );
        revalidatePath("/settings/members");
        const delivery = await deliverWorkspaceInvite({
          ...invite,
          workspaceName: appUser.workspace.workspaceName,
        });
        return { ok: true as const, inviteUrl: delivery.url, emailSent: delivery.emailSent,
        };
      } catch (error) {
        const failure = authenticatedActionResultError(
          error,
          "Invitation resend failed",
        );
        return {
          ok: false as const,
          error: failure.message,
          errorCode: failure.errorCode,
          requestId: failure.requestId,
        };
      }
    });
  } catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Invitation resend failed",
    );
    return {
      ok: false as const,
      error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
    };
  }
}

export async function revokeInviteAction(inviteId: string) {
  return executeWorkspaceActionWithInput("members.invite", { inviteId }, workspaceInviteReferenceActionSchema, async (appUser, parsedInput) => {
    await workspaceService.revokeInvite(appUser.actorUserId, appUser.workspaceId, parsedInput.inviteId,
    );
    revalidatePath("/settings/members");
  });
}

export async function changeMemberRoleAction(
  memberId: string,
  role: "admin" | "editor" | "viewer",
) {
  try {
    return await executeWorkspaceActionWithInput("members.invite", { memberId, role }, workspaceMemberRoleActionSchema, async (appUser, parsedInput) => {
      try {
        await workspaceMembershipService.changeRole(
          appUser.actorUserId,
          appUser.workspaceId,
          parsedInput.memberId,
          parsedInput.role,
        );
        revalidatePath("/settings/members");
        return { ok: true as const };
      } catch (error) {
        const failure = authenticatedActionResultError(error, "Role change failed");
        return { ok: false as const, error: failure.message,
          errorCode: failure.errorCode,
          requestId: failure.requestId,
        };
      }
    });
  } catch (error) {
    const failure = authenticatedActionResultError(error, "Role change failed");
    return { ok: false as const, error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
    };
  }
}

export async function removeMemberAction(memberId: string) {
  try {
    return await executeWorkspaceActionWithInput("members.invite", { memberId }, workspaceMemberReferenceActionSchema, async (appUser, parsedInput) => {
      try {
        await workspaceMembershipService.removeMember(
          appUser.actorUserId,
          appUser.workspaceId,
          parsedInput.memberId,
        );
        revalidatePath("/settings/members");
        return { ok: true as const };
      } catch (error) {
        const failure = authenticatedActionResultError(
          error,
          "Member removal failed",
        );
        return { ok: false as const, error: failure.message,
          errorCode: failure.errorCode,
          requestId: failure.requestId,
        };
      }
    });
  } catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Member removal failed",
    );
    return { ok: false as const, error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
    };
  }
}

export async function createApiKeyAction(input: { name: string; scopes?: string[];
}) {
  try {
    return await executeWorkspaceActionWithInput("api.manage", input, workspaceApiKeyActionSchema, async (appUser, parsedInput) => {
      try {
        const key = await workspaceService.createApiKey(
          appUser.actorUserId,
          appUser.workspaceId,
          parsedInput,
        );
        revalidatePath("/settings/api");
        return { ok: true as const, key: { ...key, createdAt: key.createdAt.toISOString() },
        };
      } catch (error) {
        const failure = authenticatedActionResultError(
          error,
          "API key creation failed",
        );
        return { ok: false as const, error: failure.message,
          errorCode: failure.errorCode,
          requestId: failure.requestId,
        };
      }
    });
  } catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "API key creation failed",
    );
    return { ok: false as const, error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
    };
  }
}

export async function revokeApiKeyAction(keyId: string) {
  return executeWorkspaceActionWithInput("api.manage", { keyId }, workspaceApiKeyReferenceActionSchema, async (appUser, parsedInput) => {
    await workspaceService.revokeApiKey(appUser.actorUserId, appUser.workspaceId, parsedInput.keyId,
    );
    revalidatePath("/settings/api");
  });
}
