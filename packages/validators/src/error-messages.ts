/** Maps internal error codes to user-facing copy. Keep messages calm,
 *  specific, and actionable. Fall back to a generic message for unknowns. */
export const USER_ERROR_MESSAGES: Record<string, string> = {
  ingest_max_duration_exceeded:
    "This video is longer than your plan allows. Upgrade or trim it and try again.",
  ingest_download_failed:
    "We couldn't download that source. Check the link and try again.",
  ingest_unsupported_format:
    "That media format isn't supported. Please upload an MP4, MOV, or common audio file.",
  ingest_job_failed:
    "We couldn't process that upload. Please try again, or contact support if it keeps failing.",
  upload_finalize_missing_key:
    "We lost track of the uploaded file while finishing setup. Please upload again.",
  worker_unhandled_error:
    "An unexpected error interrupted processing — often a brief network hiccup. Retry ingest; if it keeps failing, contact support.",
  worker_unknown_job_type:
    "We hit an unexpected internal error preparing this project. Please contact support.",
  source_download_failed:
    "We couldn't download that source. Check the link and try again.",
  remote_media_download_failed:
    "We couldn't download that media. Check the link and try again.",
  remote_url_unsafe:
    "That media link isn't safe to download. Choose another source.",
  remote_fetch_timeout:
    "The media download timed out. Try again or choose another source.",
  remote_media_too_large:
    "That media file is too large to process. Choose a smaller file and try again.",
  remote_media_invalid_content_type:
    "That link didn't return a supported audio or video file. Choose another source.",
  media_duration_unavailable:
    "We couldn't verify the media duration. Check the file and try again.",
  rss_feed_too_large:
    "That RSS feed is too large to import. Choose a feed with fewer entries.",
  rss_download_failed:
    "We couldn't fetch that RSS feed. Check the link and try again.",
  rss_missing_enclosure:
    "That RSS episode doesn't have a downloadable audio file. Choose a different episode.",
  quota_exceeded:
    "You've used all your processing minutes for this month. Upgrade to keep going.",
  transcription_failed:
    "Transcription didn't complete. Please retry — if it keeps failing, contact support.",
  transcription_run_failed:
    "Transcription didn't complete. Please retry — if it keeps failing, contact support.",
  assemblyai_transcription_failed:
    "Transcription didn't complete. Please retry — if it keeps failing, contact support.",
  moment_detection_failed: "Clip detection didn't complete. Please retry generation.",
  clip_detection_run_failed: "Clip detection didn't complete. Please retry generation.",
  clip_rendering_failed: "A clip failed to render. Try rendering it again.",
  clip_rendering_run_failed: "A clip failed to render. Try rendering it again.",
  clip_render_group_failed: "A clip failed to render. Try rendering it again.",
  clip_render_variant_failed: "A clip failed to render. Try rendering it again.",
  ffmpeg_render_failed: "A clip failed to render. Try rendering it again.",
  auto_render_queue_failed: "We couldn't queue your clips for rendering. Please try again.",
  dubbing_failed: "Voiceover dubbing didn't complete. Please try again.",
  dub_failed: "Voiceover dubbing didn't complete. Please try again.",
  dubbing_run_failed: "Voiceover dubbing didn't complete. Please try again.",
  music_download_failed: "We couldn't add that music track. Please try again.",
  broll_download_failed: "We couldn't add that b-roll clip. Please try again.",
  checkout_failed: "We couldn't start checkout. Please try again.",
  social_publish_failed: "We couldn't publish to that platform. Please try again.",
  social_post_publish_failed: "We couldn't publish that post. Please try again.",
  social_platform_unsupported: "That social platform isn't supported yet.",
  social_provider_failed:
    "The platform rejected the upload. Please try again shortly.",
  social_account_missing:
    "That account is no longer connected. Reconnect it in Settings → Social, then schedule the post again.",
  social_asset_missing:
    "The rendered clip for this post is no longer available. Re-render the clip, then schedule it again.",
  social_post_schedule_failed:
    "We couldn't schedule that post. Check the account connection and try again.",
  social_post_cancel_failed:
    "We couldn't cancel that post — it may have already started publishing. Check its current status above.",
  youtube_unsupported_source:
    "That link isn't a supported YouTube URL. Paste a youtube.com or youtu.be link.",
  youtube_missing_url:
    "No video link was provided. Paste a YouTube URL and try again.",
  link_missing_url:
    "No video link was provided. Paste a link and try again.",
  link_unsupported_source:
    "We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
  worker_command_timeout:
    "That step took too long and timed out. Please try again.",
  worker_command_failed:
    "We couldn't fetch that video. Make sure it's public and still available, then try again.",
  worker_command_missing:
    "Our processing service is temporarily unavailable. Please try again shortly, or contact support if this continues.",
  link_download_missing_file:
    "We couldn't download that video — it may be too large, private, or no longer available.",
  rate_limited:
    "You're doing that a bit too fast. Please wait a moment and try again.",
  upload_session_unavailable:
    "That saved upload is no longer available. We'll start a fresh upload safely.",
  upload_completion_reconciliation_required:
    "Your upload may already be complete, but we couldn't confirm it yet. Don't start another upload; try again later or contact support.",
  upload_presign_failed:
    "We couldn't prepare the upload. Please try again.",
  upload_complete_failed:
    "We couldn't confirm the upload completed. Re-select the same file to check its status.",
  ingest_retry_limit_exceeded:
    "You've reached the retry limit for this failed upload. Start a new upload, or contact support if the problem continues.",
  ingest_not_failed:
    "This project's status just changed — refresh the page to see its latest state.",
  source_storage_key_missing:
    "The original source for this project is no longer available. Re-upload the source to render again.",
  workflow_source_missing:
    "The original source for this project is no longer available. Re-upload the source to continue.",
  requires_pro_plan:
    "Voiceover dubbing is a Pro feature. Upgrade to Pro to dub your clips.",
  requires_creator_plan:
    "Repurposing is included with Creator and Pro plans. Upgrade to unlock it.",
  social_oauth_env_missing:
    "This platform's connection isn't configured on this server yet. Add the provider API credentials and try again.",
  social_oauth_origin_invalid:
    "This server's app URL isn't configured correctly. Contact the workspace administrator.",
  social_oauth_start_failed:
    "We couldn't start the connection flow. Please try again.",
  project_access_denied:
    "You don't have access to this project.",
  project_has_active_workflow:
    "This project has a run in progress. Wait for it to finish, then try deleting again.",
  project_deletion_incomplete:
    "We couldn't fully remove this project's files. Please try deleting again.",
  ingest_retries_exhausted:
    "We retried this upload automatically a few times and it kept failing. Try again, or contact support if it keeps happening.",
  workflow_retries_exhausted:
    "We retried this step automatically a few times and it kept failing. Please try again, or contact support if it keeps happening.",
  worker_stalled:
    "Processing was interrupted unexpectedly. Please try again, or contact support if it keeps happening.",
  clip_not_found:
    "That clip is no longer available. Refresh the page to see this project's current clips.",
  clip_title_update_failed: "We couldn't rename this clip. Please try again.",
  clip_title_suggestion_failed:
    "We couldn't come up with title ideas just now. Please try again.",
  // Configuration, not a transient fault — telling someone to "try again" sends
  // them in a loop until an operator sets the key. Also thrown by the content
  // suite, which previously fell through to the generic message.
  openai_not_configured:
    "AI features aren't configured on this server yet. Add an OpenAI API key and try again.",
  openai_request_failed:
    "Our AI provider didn't respond. Please try again in a moment.",
  openai_bad_output:
    "The AI returned something we couldn't use. Please try again.",
  clip_duplicate_failed: "We couldn't duplicate this clip. Please try again.",
  clip_delete_failed: "We couldn't delete this clip. Please try again.",
  clip_has_scheduled_posts:
    "This clip has scheduled or publishing social posts. Cancel them in Publish, then delete the clip.",
  // Extend as new codes appear.
};

export function userErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (
    USER_ERROR_MESSAGES[code] ??
    "Something went wrong. Please try again or contact support."
  );
}
