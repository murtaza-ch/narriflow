import { describe, expect, test } from "bun:test";
import { describeFailure } from "@narriflow/services/log-failure";
import { createFailureReporter, type FailureClient } from "./failure-reporter";

function harness(token: string | undefined = "phc_test") {
  const sent: Array<{ error: Error; id?: string; properties?: Record<string, unknown> }> = [];
  let time = 0, shutdowns = 0;
  const work: Promise<unknown>[] = [];
  const client: FailureClient = {
    captureExceptionImmediate: async (error, id, properties) => { sent.push({ error: error as Error, id, properties }); },
    shutdown: () => { shutdowns++; },
  };
  const report = createFailureReporter({ settings: () => ({ token, deployment: "v1" }), createClient: () => client, waitUntil: promise => work.push(promise), now: () => time });
  return { sent, report, work, advance: (ms: number) => { time += ms; }, shutdowns: () => shutdowns };
}

describe("createFailureReporter", () => {
  test("sends the constant label and frames, never the error's own text", async () => {
    const { sent, report, work } = harness();
    const failure = describeFailure(new Error('Invalid value title: "My private podcast" token=supersecretvalue for sam@example.com\nat sam@example.com said token=supersecretvalue'));
    report("unexpected_request_failure", failure, { requestId: "r1" });
    await Promise.all(work);
    const text = `${sent[0]?.error.message}${sent[0]?.error.stack}`;
    expect(sent[0]?.error.message).toBe("unexpected_request_failure");
    expect(text).toContain(".test.ts:");
    for (const secret of ["supersecretvalue", "sam@example.com", "private podcast"]) expect(text).not.toContain(secret);
  });
  test("shares only allowlisted context", async () => {
    const { sent, report, work } = harness();
    report("failure", { name: "Error" }, { requestId: "r1", route: "/x", email: "sam@example.com", url: "https://signed.example/?sig=1" });
    await Promise.all(work);
    expect(sent[0]?.properties).toMatchObject({ requestId: "r1", route: "/x", failure: "failure", deployment: "v1" });
    expect(JSON.stringify(sent[0]?.properties)).not.toContain("example");
  });
  test("groups by failure, name and code", async () => {
    const { sent, report, work } = harness();
    report("operational_critical", { name: "Error", code: "render_queue_stuck" }, {});
    await Promise.all(work);
    expect(sent[0]?.properties?.$exception_fingerprint).toBe("operational_critical:Error:render_queue_stuck");
  });
  test("unrelated bugs under one label stay separate issues, and a deploy keeps them together", async () => {
    const { sent, report, work } = harness();
    const frame = (site: string, line: number) => ({ name: "TypeError", stack: [`at async ${site} (worker.js:${line}:9)`] });
    report("workflow_command_failed", frame("renderClip", 10), { kind: "render" });
    report("workflow_command_failed", frame("renderClip", 99), { kind: "render" });
    report("workflow_command_failed", frame("renderClip", 10), { kind: "import" });
    report("workflow_command_failed", frame("publishClip", 10), { kind: "render" });
    await Promise.all(work);
    const [first, afterDeploy, otherKind, otherSite] = sent.map(event => event.properties?.$exception_fingerprint);
    expect(first).toBe("workflow_command_failed:TypeError:render:renderClip");
    expect(afterDeploy).toBe(first);
    expect(new Set([first, otherKind, otherSite]).size).toBe(3);
  });
  test("a failure loop is capped per minute, and other failures still get through", async () => {
    const { sent, report, advance } = harness();
    for (let index = 0; index < 50; index++) report("loop", { name: "Error" }, {});
    report("other", { name: "Error" }, {});
    await Promise.resolve();
    expect(sent.filter(entry => entry.properties?.failure === "loop")).toHaveLength(10);
    expect(sent.filter(entry => entry.properties?.failure === "other")).toHaveLength(1);
    advance(60_000);
    report("loop", { name: "Error" }, {});
    expect(sent.filter(entry => entry.properties?.failure === "loop")).toHaveLength(11);
  });
  test("does nothing without a token", () => {
    const { sent, report, work } = harness("");
    report("failure", { name: "Error" }, {});
    expect(sent).toEqual([]);
    expect(work).toEqual([]);
  });
  test("a PostHog outage never surfaces to the request", async () => {
    const work: Promise<unknown>[] = [];
    const report = createFailureReporter({ settings: () => ({ token: "t" }), waitUntil: promise => work.push(promise),
      createClient: () => ({ captureExceptionImmediate: async () => { throw new Error("down"); }, shutdown: () => undefined }) });
    report("failure", { name: "Error" }, {});
    await expect(Promise.all(work)).resolves.toBeDefined();
  });
  test("closes the client so the Worker keeps nothing open", async () => {
    const { report, work, shutdowns } = harness();
    report("failure", { name: "Error" }, {});
    await Promise.all(work);
    expect(shutdowns()).toBe(1);
  });
});
