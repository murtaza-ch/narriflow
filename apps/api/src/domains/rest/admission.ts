import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the rest routes, keyed by `METHOD /path` under `/api`. */
export const restAdmission = {} as const satisfies AdmissionTable;
