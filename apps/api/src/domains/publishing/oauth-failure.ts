import { SocialOAuthError } from "@narriflow/services";
import { AuthenticatedRequestFailure } from "../../http/request-policy";

/**
 * The common-envelope refusal for a social OAuth failure. Other errors (plan
 * requirements, workspace access, unexpected faults) are returned unchanged so
 * the shared error handler maps them. A missing provider configuration names
 * no environment variable.
 */
export function socialOAuthFailure(error: unknown): unknown {
  if (!(error instanceof SocialOAuthError)) return error;
  if (error.code === "social_oauth_env_missing") {
    return new AuthenticatedRequestFailure({
      code: error.code,
      category: "unavailable",
      status: 503,
      message: "This platform is not available to connect right now.",
    });
  }
  return new AuthenticatedRequestFailure({
    code: error.code,
    category: "semantic_refusal",
    status: 400,
    message: error.message,
  });
}
