"use client";

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

export function IntakeProvider({ scope, children }: { scope: WorkspaceScope; children: ReactNode }) {
  const { transport, queryClient } = useApiRuntime();
  const intake = useMemo<Intake>(
    () => ({
      scope,
      transport,
      actions: createIngestActions(transport, scope),
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
