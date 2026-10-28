"use server";

import { revalidatePath } from "next/cache";
import { autoCensorService } from "@narriflow/services";
import { workspaceCensorWordsSchema } from "@narriflow/validators";
import {
  executeWorkspaceAction,
  executeWorkspaceActionWithInput,
} from "@/lib/authenticated-request-action";

// The Workspace's censored-word list is edited from Settings and from the
// Studio's word-list dialog. Only roles that manage the workspace may change it.
function refresh() {
  revalidatePath("/settings/workspace");
}

export async function replaceCensorWordsAction(input: unknown) {
  return executeWorkspaceActionWithInput(
    "workspace.manage",
    input,
    workspaceCensorWordsSchema,
    async (actor, words) => {
      const saved = await autoCensorService.replaceWorkspaceWords(actor, words);
      refresh();
      return { ok: true as const, ...saved };
    },
  );
}

export async function resetCensorWordsAction() {
  return executeWorkspaceAction("workspace.manage", async (actor) => {
    const saved = await autoCensorService.resetWorkspaceWords(actor);
    refresh();
    return { ok: true as const, ...saved };
  });
}
