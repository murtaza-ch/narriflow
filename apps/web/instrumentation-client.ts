import posthog from "posthog-js";
import { isUntrackedPath, scrubAnalyticsEvent } from "./lib/analytics";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (token && !isUntrackedPath(window.location.pathname)) {
  posthog.init(token, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    capture_exceptions: true,
    before_send: scrubAnalyticsEvent,
    // Clicked text can be a title, caption or transcript, so it stays in the browser.
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    // Off until its masking has been reviewed: page text is not masked by default.
    disable_session_recording: true,
  });
  window.narriflowAnalytics = {
    capture: (event, properties) => { posthog.capture(event, properties); },
    identify: (distinctId) => { posthog.identify(distinctId); },
    // Resetting an anonymous visitor would mint a new person on every page load.
    reset: () => { if (posthog.get_property("$user_state") === "identified") posthog.reset(); },
  };
}
