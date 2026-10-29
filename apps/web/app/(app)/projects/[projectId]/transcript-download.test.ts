import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import type { ProjectsClient } from "@narriflow/api-client/projects";
import { fetchTranscriptFile } from "./transcript-download";

function clientReturning(response: Response, seen: unknown[] = []): ProjectsClient {
	return {
		projects: {
			":id": {
				transcript: {
					export: {
						$get: async (args: unknown) => {
							seen.push(args);
							return response;
						},
					},
				},
			},
		},
	} as unknown as ProjectsClient;
}

describe("Transcript download", () => {
	test("reads the file through the typed client and keeps the server's file name", async () => {
		const seen: unknown[] = [];
		const response = new Response("1\n00:00 --> 00:01\nhello", {
			headers: { "Content-Type": "application/x-subrip", "Content-Disposition": 'attachment; filename="show.srt"' },
		});
		const file = await fetchTranscriptFile(clientReturning(response, seen), "p1", "srt");
		expect(file.fileName).toBe("show.srt");
		expect(await file.blob.text()).toContain("hello");
		expect(seen).toEqual([{ param: { id: "p1" }, query: { format: "srt" } }]);
	});

	test("falls back to a named file when the server sent no name", async () => {
		const file = await fetchTranscriptFile(clientReturning(new Response("text")), "p1", "txt");
		expect(file.fileName).toBe("transcript.txt");
	});

	test("a refusal surfaces as the typed error and nothing is saved", async () => {
		const refusal = new Response(JSON.stringify({ error: "capability_denied", message: "No", requestId: "r1" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
		await expect(fetchTranscriptFile(clientReturning(refusal), "p1", "vtt")).rejects.toBeInstanceOf(ApiError);
	});

	test("an oversized declared body is refused before it is read", async () => {
		const huge = new Response("x", { headers: { "Content-Length": String(100 * 1024 * 1024) } });
		await expect(fetchTranscriptFile(clientReturning(huge), "p1", "txt")).rejects.toBeInstanceOf(RangeError);
	});
});
