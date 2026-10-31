import { ScopedDomainWorkflow } from "./scoped-workflow";
export class ImportPipeline extends ScopedDomainWorkflow { protected readonly workflowKind = "import_pipeline" as const; }
