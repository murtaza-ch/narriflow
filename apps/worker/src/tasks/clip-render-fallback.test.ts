import { describe, expect, test } from "bun:test";
import { WorkflowFailure } from "@narriflow/services";
import { WorkerProcessFailure } from "../worker-process";
import {
	isRecoverableRangedSourceFailure,
	normalizeRenderProcessFailure,
} from "./clip-render-attempt";

describe("ranged source recovery", () => {
	for (const diagnostic of [
		"HTTP error 503 Service Unavailable",
    "Server returned 5XX Server Error reply",
		"Server returned 429 Too Many Requests",
		"Connection reset by peer",
		"Stream ends prematurely at 1024, should be 4096",
		"HTTP server does not support byte range",
	])
		test(`permits a demonstrated transport limitation: ${diagnostic}`, () => {
			expect(
				isRecoverableRangedSourceFailure(
					new WorkerProcessFailure(
						"worker_command_failed",
						"retryable",
						"Probe failed",
						diagnostic,
					),
				),
			).toBe(true);
		});

	test("retains process provenance through inspectMedia's invalid-source wrapper", () => {
		const cause = new WorkerProcessFailure(
			"worker_command_input_invalid",
			"permanent",
			"Probe rejected input",
			"HTTP error 503 Service Unavailable",
		);
		expect(
			isRecoverableRangedSourceFailure(
				new WorkflowFailure(
					"source_media_invalid",
					"permanent",
					"Media could not be decoded",
					{ cause },
				),
			),
		).toBe(true);
	});

	for (const error of [
		new WorkerProcessFailure(
			"worker_command_spawn_failed",
			"retryable",
			"EBADF",
			"HTTP error 503",
			null,
			{ errno: "EBADF", failureScope: "executor", executableClass: "ffprobe" },
		),
		new WorkerProcessFailure(
			"worker_command_unavailable",
			"retryable",
			"Missing binary",
			"",
			null,
			{ errno: "ENOENT", failureScope: "configuration" },
		),
		new WorkerProcessFailure(
			"worker_command_timeout",
			"retryable",
			"Deadline",
			"Connection timed out",
		),
		new WorkerProcessFailure(
			"worker_command_failed",
			"retryable",
			"Unknown failure",
			"Permission denied",
		),
		new WorkerProcessFailure(
			"worker_command_input_invalid",
			"permanent",
			"Corrupt",
			"moov atom not found",
		),
		new WorkerProcessFailure(
			"worker_command_input_invalid",
			"permanent",
			"Missing",
			"HTTP error 404 Not Found",
		),
		new WorkflowFailure(
			"source_media_invalid",
			"permanent",
			"Corrupt immutable source",
		),
		new WorkflowFailure(
			"invalid_clip_document",
			"permanent",
			"Invalid document",
		),
		new Error("posix_spawn EBADF"),
	])
		test(`bypasses full download for ${error.message}`, () =>
			expect(isRecoverableRangedSourceFailure(error)).toBe(false));
});

describe("required HDR filter health", () => {
	for (const filter of ["zscale", "tonemap"])
		test(`${filter} absence quarantines the image instead of the clip`, () => {
			const cause = new WorkerProcessFailure(
				"worker_command_failed",
				"retryable",
				"Encode failed",
				`No such filter: '${filter}'`,
			);
			const error = normalizeRenderProcessFailure(cause);
			expect(error).toBeInstanceOf(WorkerProcessFailure);
			expect(error).toMatchObject({
				code: "worker_render_filter_unavailable",
				disposition: "retryable",
				failureScope: "configuration",
				executableClass: "ffmpeg",
				cause,
			});
		});
	test("ordinary render failures retain identity", () => {
		const failure = new WorkerProcessFailure(
			"worker_command_timeout",
			"retryable",
			"Deadline",
			"",
		);
		expect(normalizeRenderProcessFailure(failure)).toBe(failure);
	});
});
