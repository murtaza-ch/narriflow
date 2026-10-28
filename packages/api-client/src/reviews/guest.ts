import { ApiError, apiErrorFromResponse } from "../core/error";
import { createReviewsClient } from "./index";

/** Guest and public requests have no Clerk identity or Workspace. No automatic retries, including access exchange. */
export function createGuestReviewsClient(options: {
  baseUrl: string;
  getSession(): string | null;
  onSessionRefused?(): void;
  fetch?: typeof globalThis.fetch;
}) {
  const baseUrl = new URL(options.baseUrl).origin;
  const fetcher = options.fetch ?? globalThis.fetch;
  return createReviewsClient({
    baseUrl,
    async fetch(input, init) {
      const url = new URL(input.toString());
      if (url.origin !== baseUrl) throw new TypeError("Review requests must use the API origin");
      const headers = new Headers(init?.headers);
      headers.delete("Authorization"); headers.delete("X-Workspace-Id");
      const session = options.getSession();
      if (session) headers.set("Authorization", `Bearer ${session}`);
      let response: Response;
      try { response = await fetcher(url, { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store" }); }
      catch (cause) { throw new ApiError({ code: "network_error", message: "Could not reach Narriflow. Try again.", status: 0, cause }); }
      if (!response.ok) {
        const error = await apiErrorFromResponse(response);
        if (error.code === "review_session_invalid" || error.code === "review_access_invalid") options.onSessionRefused?.();
        throw error;
      }
      return response;
    },
  });
}
