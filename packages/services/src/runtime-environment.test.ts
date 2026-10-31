import { expect, test } from "bun:test";
import { readServiceEnvironment, withServiceEnvironment } from "./runtime-environment";

test("settings come only from the current invocation and never from process.env", async () => {
  expect(readServiceEnvironment).toThrow("Service environment is unavailable");
  const first = withServiceEnvironment({ OPENAI_API_KEY: "first" }, async () => {
    await Promise.resolve();
    expect(readServiceEnvironment().OPENAI_API_KEY).toBe("first");
  });
  await withServiceEnvironment({ OPENAI_API_KEY: "second" }, async () => {
    await first;
    expect(readServiceEnvironment().OPENAI_API_KEY).toBe("second");
  });
  expect(readServiceEnvironment).toThrow("Service environment is unavailable");
});
