import { ScopedDomainWorkflow } from "./scoped-workflow";
export class Maintenance extends ScopedDomainWorkflow { protected readonly workflowKind = "maintenance" as const; }
