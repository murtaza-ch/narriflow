import type { AdmissionTable } from "../platform/admission-table";

export const executionAdmission = {
  "POST /execution/command": { trust: "executor_signature" },
  "POST /execution/transfer": { trust: "executor_signature" },
} as const satisfies AdmissionTable;
