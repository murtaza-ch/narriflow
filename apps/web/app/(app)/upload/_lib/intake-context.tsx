"use client";

import { track } from "@/lib/analytics";
import { type ApiTransport, type WorkspaceScope } from "@narriflow/api-client/core";
import { type IngestActions, createIngestActions, invalidateAfterIntake } from "@narriflow/api-client/ingest";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiRuntime } from "@/app/_components/api-provider";

/** What the import steps need to talk to the API, bound to one identity and Workspace. */
export interface Intake {
  scope: WorkspaceScope;
  transport: ApiTransport;
  actions: IngestActions;
  /** Refreshes what an accepted import changed: Projects, library, ingest reads and credits. */
  accepted(): Promise<void>;
}

const IntakeContext = createContext<Intake | null>(null);

/** Records the attempt only: the link itself stays out of analytics. */
function trackedIngestActions(actions: IngestActions): IngestActions {
  return {
    ...actions,
    commitLink: (...args) => { track("import_submit", { source: "link" }); return actions.commitLink(...args); },
    commitDrive: (...args) => { track("import_submit", { source: "drive" }); return actions.commitDrive(...args); },
    importRss: (...args) => { track("import_submit", { source: "rss" }); return actions.importRss(...args); },
    uploadSessions: { ...actions.uploadSessions, open: (...args) => { track("import_submit", { source: "file" }); return actions.uploadSessions.open(...args); } },
  };
}

export function IntakeProvider({ scope, children }: { scope: WorkspaceScope; children: ReactNode }) {
  const { transport, queryClient } = useApiRuntime();
  const intake = useMemo<Intake>(
    () => ({
      scope,
      transport,
      actions: trackedIngestActions(createIngestActions(transport, scope)),
      accepted: () => invalidateAfterIntake(queryClient, scope),
    }),
    [scope, transport, queryClient],
  );
  return <IntakeContext.Provider value={intake}>{children}</IntakeContext.Provider>;
}

export function useIntake(): Intake {
  const intake = useContext(IntakeContext);
  if (!intake) throw new Error("useIntake must be used inside IntakeProvider");
  return intake;
}
