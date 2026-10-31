import { getPrismaClient } from "@narriflow/db/client";
import { LayoutEvidenceLifecycle } from "./layout-evidence";

export function getLayoutEvidenceLifecycle(): LayoutEvidenceLifecycle {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    return new LayoutEvidenceLifecycle({ prisma });
}
