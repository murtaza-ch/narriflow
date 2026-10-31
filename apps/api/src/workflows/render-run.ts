import { ScopedDomainWorkflow } from "./scoped-workflow";
export class RenderRun extends ScopedDomainWorkflow { protected readonly workflowKind = "render_run" as const; }
