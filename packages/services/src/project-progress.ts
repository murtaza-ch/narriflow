import { Prisma } from "@prisma/client";

/** SQL ordering for the same relevant-run choice used above. */
export function projectProgressWorkflowOrderSql() {
	return Prisma.sql`CASE WHEN status IN ('queued', 'running', 'waiting') THEN 0 ELSE 1 END, "updatedAt" DESC, id DESC`;
}

/** SQL status expression for the same product progress status used above. */
export function projectProgressStatusSql(input: {
	ingestStatus: Prisma.Sql;
	workflowStatus: Prisma.Sql;
}) {
	return Prisma.sql`
		CASE
			WHEN ${input.ingestStatus} = 'failed' THEN 'failed'
			WHEN ${input.ingestStatus} IN ('queued', 'pending') THEN 'queued'
			WHEN ${input.ingestStatus} <> 'ready' THEN 'processing'
			WHEN ${input.workflowStatus} = 'queued' THEN 'queued'
			WHEN ${input.workflowStatus} IN ('running', 'waiting') THEN 'processing'
			WHEN ${input.workflowStatus} = 'failed' THEN 'failed'
			ELSE 'ready'
		END
	`;
}
