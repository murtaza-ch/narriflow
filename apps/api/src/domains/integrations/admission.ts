import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the integrations routes, keyed by `METHOD /path` under `/api`. */
export const integrationsAdmission = {} as const satisfies AdmissionTable;
