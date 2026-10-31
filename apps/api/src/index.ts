import { loadApiConfig } from "./config";
import { createProductionApp } from "./runtime";
import { createApiWorker } from "./worker";

export default createApiWorker({
  createApp(environment, runInvocation) {
    return createProductionApp(loadApiConfig(environment), environment, runInvocation);
  },
});

export { RateLimiter } from "./durable-objects/rate-limiter";
