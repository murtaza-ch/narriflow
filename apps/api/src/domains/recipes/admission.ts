import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the recipes routes, keyed by `METHOD /path` under `/api`. */
export const recipesAdmission = {
  "GET /recipes": { kind: "workspace", capability: "content.view" },
  "POST /recipes": { kind: "workspace", capability: "content.edit", deferRateRefusal: true, rate: { scope: "workspace", prefix: "recipe-create", limit: 30, windowSeconds: 3600 } },
  "PATCH /recipes/:recipeId": { kind: "workspace", capability: "content.edit" },
  "POST /recipes/:recipeId/duplicate": { kind: "workspace", capability: "content.edit", deferRateRefusal: true, rate: { scope: "workspace", prefix: "recipe-create", limit: 30, windowSeconds: 3600 } },
  "DELETE /recipes/:recipeId": { kind: "workspace", capability: "content.edit" },
} as const satisfies AdmissionTable;
