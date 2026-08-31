import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";

import {
	GeneratedMediaPanel,
	type GeneratedMediaGalleryItem,
} from "./generated-media-panel";

function render(
	jobs: readonly GeneratedMediaGalleryItem[] = [],
	activeBrandProfile: { id: string; name: string } | null = null,
) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<GeneratedMediaPanel
				projectId="00000000-0000-4000-8000-000000000001"
				clipId="00000000-0000-4000-8000-000000000002"
				basePlayheadSec={3}
				baseDurationSec={20}
				compositePlayheadSec={6}
				compositeDurationSec={23}
				imageAvailable
				videoAvailable={false}
				promptSources={[
					{
						id: "selection-1",
						label: "Selected transcript",
						origin: {
							kind: "transcript_selection",
							sourceIds: [
								"clip:00000000-0000-4000-8000-000000000002:transcript:utterance-1",
							],
						},
						prompt: "A host speaking into a studio microphone",
						derivedContext: "The host explains a quiet morning ritual.",
					},
				]}
				jobs={jobs}
				selectedBrollPlacementId={null}
				activeBrandProfile={activeBrandProfile}
				usage={null}
				onGenerate={async () => {}}
				onRefresh={() => {}}
				onCancel={async () => {}}
				onInsert={async () => {}}
				onSaveToBrand={async () => {}}
				onDownload={() => {}}
				onDelete={async () => {}}
			/>
		</ChakraProvider>,
	);
}

describe("GeneratedMediaPanel", () => {
	test("keeps derived transcript context separate and video visibly gated", () => {
		const markup = render();
		expect(markup).toContain("Transcript context");
		expect(markup).toContain("Remove context");
		expect(markup).toContain("Editable prompt");
		expect(markup).toContain("Video gated");
		expect(markup).toContain("No automatic placement");
		expect(markup).toContain("Generated results stay here when you close Studio");
	});

	test("renders explicit placement, brand, download, and deletion actions", () => {
		const markup = render([
			{
				id: "job-1",
				kind: "image",
				status: "completed",
				errorCode: null,
				moderationOutcome: "passed",
				assetAvailability: "available",
				savedToActiveBrandProfile: false,
				asset: {
					jobId: "job-1",
					assetId: "asset-1",
					fingerprint: "fingerprint-1",
					kind: "image",
					durationSec: null,
					title: "Dawn studio",
					accessUrl: "https://media.example.test/generated.png",
				},
			},
		]);
		expect(markup).toContain("Insert at playhead");
		expect(markup).toContain("Replace B-roll");
		expect(markup).toContain("Select a B-roll item on the timeline first");
		expect(markup).toContain("Add as scene");
		expect(markup).toContain("Save to brand");
		expect(markup).toContain("Assign an active Brand Profile to this project first");
		expect(markup).toContain('alt="Dawn studio"');
		expect(markup).toContain('aria-label="Download Dawn studio"');
		expect(markup).toContain('aria-label="Delete Dawn studio"');
	});

	test("keeps a saved-to-brand success state visible after history refresh", () => {
		const markup = render([
			{
				id: "job-saved",
				kind: "image",
				status: "completed",
				errorCode: null,
				moderationOutcome: "passed",
				assetAvailability: "available",
				savedToActiveBrandProfile: true,
				asset: {
					jobId: "job-saved",
					assetId: "asset-saved",
					fingerprint: "fingerprint-saved",
					kind: "image",
					durationSec: null,
					title: "Dawn studio",
					accessUrl: "https://media.example.test/generated.png",
				},
			},
		], { id: "profile-1", name: "Northstar" });

		expect(markup).toContain("Saved to Northstar");
		expect(markup).toContain("disabled");
	});

	test("keeps an asynchronous result cancellable after Studio is reopened", () => {
		const markup = render([
			{
				id: "job-2",
				kind: "image",
				status: "waiting",
				errorCode: null,
				moderationOutcome: "pending",
				assetAvailability: "not_ready",
				savedToActiveBrandProfile: false,
				asset: null,
			},
		]);
		expect(markup).toContain("Waiting for provider");
		expect(markup).toContain('aria-label="Cancel generation job-2"');
	});

	test("distinguishes deleted and reconciliation-held results from finalizing work", () => {
		const markup = render([
			{
				id: "job-3",
				kind: "image",
				status: "completed",
				errorCode: null,
				moderationOutcome: "passed",
				assetAvailability: "deleted",
				savedToActiveBrandProfile: false,
				asset: null,
			},
			{
				id: "job-4",
				kind: "image",
				status: "reconciliation_required",
				errorCode: "generated_media_provider_outcome_unknown",
				moderationOutcome: "pending",
				assetAvailability: "not_ready",
				savedToActiveBrandProfile: false,
				asset: null,
			},
		]);
		expect(markup).toContain("Deleted from the media library");
		expect(markup).toContain("Provider outcome needs reconciliation");
		expect(markup).not.toContain('aria-label="Cancel generation job-4"');
	});
});
