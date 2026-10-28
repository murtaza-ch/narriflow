import { PROJECTS_RECEIPT_COMMANDS } from "./projects-receipt-commands";

/** Dependencies of the projects receipt-backed commands. The owning ticket adds what its commands need. */
export type ProjectsCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the projects domain. Only names registered
 * in `PROJECTS_RECEIPT_COMMANDS` may be recorded.
 */
export function createProjectsCommands(_dependencies: ProjectsCommandDependencies) {
  return { receiptCommands: PROJECTS_RECEIPT_COMMANDS };
}

export type ProjectsCommands = ReturnType<typeof createProjectsCommands>;
