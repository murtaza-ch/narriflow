import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { librarySearchService } from "./library-search-runtime";
import { workspaceService } from "./workspace.service";

const actor = { actorUserId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002" };

describe("librarySearchService", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("refuses a user who cannot view the Workspace before reading the index", async () => {
    const refusal = new ExpectedDomainFailureError({ code: "workspace_access_denied", kind: "forbidden", message: "You do not have access to this Workspace" });
    const requireActor = spyOn(workspaceService, "requireActor").mockRejectedValue(refusal);
    spies.push(requireActor);

    // The index is unreachable in this test, so only the refusal can be thrown.
    await expect(librarySearchService.search(actor, { query: "pricing" })).rejects.toBe(refusal);
    expect(requireActor).toHaveBeenCalledWith(actor.actorUserId, actor.workspaceId, "content.view");
  });
});
