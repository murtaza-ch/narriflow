import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the session routes, keyed by `METHOD /path` under `/api`. */
export const sessionAdmission = {} as const satisfies AdmissionTable;
