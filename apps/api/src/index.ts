import { loadApiConfig } from "./config";
import { createProductionApp } from "./runtime";
import { createApiWorker } from "./worker";

export default createApiWorker({
  createApp(environment, runInvocation) {
    return createProductionApp(loadApiConfig(environment), environment, runInvocation);
  },
});

export { RateLimiter } from "./durable-objects/rate-limiter";

export { ProjectProgress } from "./durable-objects/project-progress";
export { LocalFetchMailbox } from "./durable-objects/local-fetch-mailbox";
export { DevelopmentBindings } from "./development-bindings";
export { CutoverVerification } from "../scripts/gates/candidate-verification-entrypoint";
export { ImportPipeline } from "./workflows/import-pipeline";
export { RenderRun } from "./workflows/render-run";
export { OperationDriver } from "./workflows/operation-driver";
export { Maintenance } from "./workflows/maintenance";
