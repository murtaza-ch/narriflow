import { getPrismaClient } from "@narriflow/db/client";
import { LayoutEvidenceLifecycle } from "./layout-evidence";

let lifecycle: LayoutEvidenceLifecycle | undefined;
export function getLayoutEvidenceLifecycle(): LayoutEvidenceLifecycle {
  if (!lifecycle) {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    lifecycle = new LayoutEvidenceLifecycle({ prisma });
  }
  return lifecycle;
}
