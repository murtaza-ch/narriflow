import { ScopedDomainWorkflow } from "./scoped-workflow";
export class OperationDriver extends ScopedDomainWorkflow { protected readonly workflowKind = "operation_driver" as const; }
