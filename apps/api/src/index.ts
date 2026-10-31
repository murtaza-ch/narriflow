import { loadApiConfig } from "./config";
import { createProductionApp } from "./runtime";
import { createApiWorker } from "./worker";

export default createApiWorker({
  createApp(environment) {
    return createProductionApp(loadApiConfig(environment), environment);
  },
});

export { RateLimiter } from "./durable-objects/rate-limiter";
