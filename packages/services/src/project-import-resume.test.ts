import { expect, test } from "bun:test";
import { ProjectService } from "./project.service";

const scope = { actorUserId: "user-test", workspaceId: "workspace-test" };

for (const sourceType of ["youtube", "upload", "rss"]) {
  test(`a configured ${sourceType} import resumes progress before its first workflow run exists`, async () => {
    const service = {
      requireActor: async () => {},
      getProjectSnapshot: async () => ({ project: { id: "p1", sourceType, ingestStatus: "queued" }, activeRun: null }),
      getLatestContentPack: async () => ({ draft: false, outputTypes: ["short_clip"], clipCountTarget: 5, clipDurationSecTarget: 30, platformPlaybookVersion: "v1" }),
    } as unknown as ProjectService;
    expect(await ProjectService.prototype.getLinkResume.call(service, scope, "p1")).toEqual({ outcome: "open_project" });
  });
}
