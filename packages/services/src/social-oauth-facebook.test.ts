import { describe, expect, test } from "bun:test";
import { eligibleFacebookPages, grantedFacebookScopes, readSocialProviderJson, SocialOAuthError } from "./social-oauth.service";

describe("Facebook Page OAuth contract", () => {
  test("lists only bounded Pages with the CREATE_CONTENT role", () => {
    expect(eligibleFacebookPages({ data: [
      { id: "eligible-page", name: "Launch Page", access_token: "page-token", tasks: ["ANALYZE", "CREATE_CONTENT"], picture: { data: { url: "https://images.example.test/page.jpg" } } },
      { id: "viewer-page", name: "Viewer", access_token: "viewer-token", tasks: ["ANALYZE"] },
      { id: "missing-token", name: "Missing token", tasks: ["CREATE_CONTENT"] },
    ] })).toEqual([{
      id: "eligible-page",
      name: "Launch Page",
      accessToken: "page-token",
      avatarUrl: "https://images.example.test/page.jpg",
      tasks: ["ANALYZE", "CREATE_CONTENT"],
    }]);
  });

  test("records only permissions Meta reports as granted", () => {
    expect(grantedFacebookScopes({ data: [
      { permission: "pages_show_list", status: "granted" },
      { permission: "pages_manage_posts", status: "declined" },
      { permission: "pages_read_engagement", status: "expired" },
    ] })).toEqual(["pages_show_list"]);
  });

  test("maps provider failures to a stable code without retaining response content", async () => {
    const secretBody = JSON.stringify({ error: { message: "token=provider-secret", user_title: "Private Page" } });
    const outcome = readSocialProviderJson(new Response(secretBody, { status: 403 }));
    await expect(outcome).rejects.toBeInstanceOf(SocialOAuthError);
    await expect(outcome).rejects.toMatchObject({ code: "social_oauth_http_failed", message: "Social provider request failed with status 403" });
    try {
      await outcome;
    } catch (error) {
      expect(String(error)).not.toContain("provider-secret");
      expect(String(error)).not.toContain("Private Page");
    }
  });
});
