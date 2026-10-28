import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the progress routes, keyed by `METHOD /path` under `/api`. */
export const progressAdmission = {} as const satisfies AdmissionTable;
