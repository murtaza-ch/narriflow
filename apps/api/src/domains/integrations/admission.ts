import type { AdmissionTable } from "../platform/admission-table";

export const integrationsAdmission = {
  "GET /integrations/mcp/status": { kind: "workspace", capability: "content.view" },
  "GET /integrations/mcp/preparations": { kind: "signed_in" },
  "GET /integrations/mcp/upload-handoff": { kind: "signed_in" },
  "POST /mcp/confirmations": { kind: "signed_in", deferRateRefusal: true },
} as const satisfies AdmissionTable;
