import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the billing routes, keyed by `METHOD /path` under `/api`. */
export const billingAdmission = {} as const satisfies AdmissionTable;
