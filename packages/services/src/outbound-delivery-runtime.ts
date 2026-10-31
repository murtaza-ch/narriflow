import { getPrismaClient } from "@narriflow/db/client";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { createNotificationBodyStorage } from "./notification-body-storage";
import { createOperationStatusReader } from "./operation-status";
import { OutboundDeliveryService } from "./outbound-delivery";
import { readServiceEnvironment } from "./runtime-environment";

/** Fresh ports on every command; no Prisma, binding or signing key is cached. */
export function getOutboundDeliveryService() {
	const database = getPrismaClient(),
		env = readServiceEnvironment();
	if (!database) throw new Error("Database scope required");
	const body = createNotificationBodyStorage({
		accountId: env.R2_ACCOUNT_ID ?? "",
		bucket: env.R2_BUCKET ?? "",
		accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
		secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
	});
	return new OutboundDeliveryService(database, {
		body,
		register: deliverExecutionDispatches,
		readTrusted: (scope, operation) =>
			createOperationStatusReader(database).readTrusted(scope, operation),
	});
}
