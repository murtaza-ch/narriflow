import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the studio routes, keyed by `METHOD /path` under `/api`. */
export const studioAdmission = {} as const satisfies AdmissionTable;
