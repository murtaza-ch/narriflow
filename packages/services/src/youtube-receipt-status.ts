export type YouTubeStatusResource = {
	status?: {
		uploadStatus?: string;
		failureReason?: string;
		rejectionReason?: string;
		privacyStatus?: string;
	};
};

export function interpretYouTubeProcessingStatus(
	resource: YouTubeStatusResource,
) {
	const uploadStatus = resource.status?.uploadStatus ?? "uploaded";
	const failed = ["failed", "rejected", "deleted"].includes(uploadStatus);
	return {
		status: failed
			? ("failed" as const)
			: uploadStatus === "processed"
				? ("succeeded" as const)
				: ("processing" as const),
		failureCode: failed ? "youtube_processing_failed" : null,
		visibility: resource.status?.privacyStatus ?? null,
	};
}
