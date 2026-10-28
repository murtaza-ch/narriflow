import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the developer routes, keyed by `METHOD /path` under `/api`. */
export const developerAdmission = {} as const satisfies AdmissionTable;
