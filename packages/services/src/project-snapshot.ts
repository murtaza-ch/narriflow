import type {
	IngestStatus as PrismaIngestStatus,
	Project,
} from "@prisma/client";
import type { RetentionPolicyKey } from "./project-retention.service";

export interface ProjectSnapshot {
	id: string;
	workspaceId: string;
	createdByUserId: string | null;
	folderId?: string | null;
	title: string;
	sourceMediaUrl: string;
	sourceType: "upload" | "youtube" | "rss" | "link";
	sourceProvider: string | null;
	sourceInput: string | null;
	sourceStorageKey: string | null;
	sourceMimeType: string | null;
	sourceSizeBytes: number | null;
	sourceDurationSeconds: number | null;
	languageCode: string | null;
	brandProfileId: string | null;
	brandTemplateId: string | null;
	ingestStatus: PrismaIngestStatus;
	ingestErrorCode: string | null;
	ingestCompletedAt: string | null;
	notifyOnComplete: boolean;
	retentionPolicyKey: RetentionPolicyKey | null;
	expiresAt: string | null;
	persisted: boolean;
	createdAt: string;
}

function bigintToNumber(value: bigint | number | null) {
	if (value === null) {
		return null;
	}

	return Number(value);
}

export function toProjectSnapshot(row: Project): ProjectSnapshot {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		createdByUserId: row.createdByUserId,
		folderId: row.folderId,
		title: row.title,
		sourceMediaUrl: row.sourceMediaUrl,
		sourceType: row.sourceType,
		sourceProvider: row.sourceProvider,
		sourceInput: row.sourceInput,
		sourceStorageKey: row.sourceStorageKey,
		sourceMimeType: row.sourceMimeType,
		sourceSizeBytes: bigintToNumber(row.sourceSizeBytes),
		sourceDurationSeconds: row.sourceDurationSeconds,
		languageCode: row.languageCode,
		brandProfileId: row.brandProfileId,
		brandTemplateId: row.brandTemplateId,
		ingestStatus: row.ingestStatus,
		ingestErrorCode: row.ingestErrorCode,
		ingestCompletedAt: row.ingestCompletedAt
			? row.ingestCompletedAt.toISOString()
			: null,
		notifyOnComplete: row.notifyOnComplete,
		retentionPolicyKey: row.retentionPolicyKey as RetentionPolicyKey | null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		persisted: true,
		createdAt: row.createdAt.toISOString(),
	};
}
