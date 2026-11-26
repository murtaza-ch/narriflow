import type { IntentReceipt } from "./studio-editing-session";

/** Why the editing session refused an edit, in words: the toast a one-shot Apply shows instead of a success. */
export function refusedEditToast(receipt: Extract<IntentReceipt, { accepted: false }>): { title: string; description: string } {
  switch (receipt.reason) {
    case "read-only":
      return { title: "Read-only here", description: "This clip is open for editing in another tab. Take over to make changes." };
    case "conflict":
      return { title: "Your clip is unchanged", description: "This clip changed somewhere else. Reload to keep editing." };
    case "starting":
      return { title: "Your clip is unchanged", description: "The editor is still loading. Try again in a moment." };
    case "closed":
      return { title: "Your clip is unchanged", description: "The editor has closed. Reload to keep editing." };
  }
}
