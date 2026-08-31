import { expect, test } from "bun:test";

test("generated-media automation validator composes without import-time failure", async () => {
  const module = await import("./generated-media");
  expect(module.generatedMediaAutomationSubmitSchema).toBeDefined();
  expect(module.generatedMediaSubmitSchema).toBeDefined();
});
