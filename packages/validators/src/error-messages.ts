/** Maps internal error codes to user-facing copy. Keep messages calm,
 *  specific, and actionable. Fall back to a generic message for unknowns. */
export const USER_ERROR_MESSAGES: Record<string, string> = {
  workspace_name_invalid:
    "Workspace names must be between 1 and 80 characters.",
  workspace_timezone_invalid:
    "Enter a valid IANA timezone, such as America/New_York.",
  workspace_collaboration_disabled:
    "Workspace collaboration is not enabled for this account.",
  workspace_invites_require_business:
    "Workspace invitations require the Business plan.",
  workspace_admin_invite_owner_required:
    "Only Workspace owners can invite admins.",
  workspace_invite_email_invalid: "Enter a valid email address.",
  workspace_member_already_exists:
    "This person is already a Workspace member.",
  workspace_invite_unavailable: "This invitation is no longer available.",
  workspace_api_requires_business:
    "Workspace API keys require the Business plan.",
  workspace_api_name_required: "Enter a name for this API key.",
  workspace_api_scope_invalid:
    "One or more requested API key permissions are unsupported.",
  workspace_paid_members_unavailable:
    "This Workspace cannot add paid members right now.",
  workspace_billing_action_required:
    "Resolve Workspace billing before adding a paid member.",
  workspace_invite_invalid: "This invitation is invalid or has expired.",
  workspace_invite_email_mismatch:
    "Sign in with the email address this invitation was sent to.",
  workspace_members_unavailable:
    "This Workspace cannot accept members right now.",
  workspace_admin_promotion_owner_required:
    "Only Workspace owners can promote admins.",
  workspace_member_not_found: "This member is no longer available.",
  workspace_owner_role_immutable: "The Workspace owner role cannot be changed.",
  workspace_admin_peer_forbidden: "Admins cannot manage other admins.",
  workspace_owner_removal_forbidden: "The Workspace owner cannot be removed.",
  workspace_creation_disabled:
    "Workspace creation is not enabled for this account.",
  workspace_user_not_found: "Your account is no longer available.",
  workspace_limit_reached:
    "This account has reached the Workspace limit.",
  workspace_checkout_state_invalid:
    "This Workspace is not awaiting Business checkout.",
  upload_session_idempotency_conflict:
    "This upload was already started with different settings. Start a new upload.",
  upload_session_not_found:
    "This upload is no longer available. Choose the file again to restart it.",
  upload_session_invalid_state:
    "This upload changed state. Refresh its status before trying again.",
  upload_session_integrity_failed:
    "The uploaded file could not be verified. Choose the file again to restart it.",
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
	storage_metadata_invalid:
		"We hit an internal storage error preparing this project. Please contact support; retrying the same upload won't resolve it.",
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
	rss_invalid_xml:
		"That URL did not return valid XML. Check the feed address and try again.",
	rss_unsupported_document: "That URL is not a supported RSS or Atom feed.",
	rss_no_media_episodes:
		"That feed does not contain downloadable audio or video episodes.",
	rss_concurrent_ingest_limit_reached:
		"Five RSS episodes are already importing in this workspace. Wait for one to finish and try again.",
	rss_episode_not_found:
		"That episode is no longer present in the feed. Refresh the feed and choose another episode.",
	autopilot_rule_limit_reached:
		"This workspace already has ten Autopilot rules. Remove an old rule before creating another.",
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
	moment_detection_failed:
		"Clip detection didn't complete. Please retry generation.",
	clip_detection_run_failed:
		"Clip detection didn't complete. Please retry generation.",
	clip_rendering_failed: "A clip failed to render. Try rendering it again.",
	clip_rendering_run_failed: "A clip failed to render. Try rendering it again.",
	clip_render_group_failed: "A clip failed to render. Try rendering it again.",
	clip_render_variant_failed:
		"A clip failed to render. Try rendering it again.",
	ffmpeg_render_failed: "A clip failed to render. Try rendering it again.",
	auto_render_queue_failed:
		"We couldn't queue your clips for rendering. Please try again.",
	dubbing_failed: "Voiceover dubbing didn't complete. Please try again.",
	dub_failed: "Voiceover dubbing didn't complete. Please try again.",
	dubbing_run_failed: "Voiceover dubbing didn't complete. Please try again.",
	// L10: `music_download_failed`/`sfx_download_failed` are RESERVED — render-
	// clips.ts's music/SFX download failures are log-and-skip (the track is
	// silently dropped from the render, never fails the clip; see the
	// `clip_music_download_failed`/`clip_sfx_download_failed` structured logs
	// there), so these codes never actually reach a user-facing error surface
	// today. Kept mapped here anyway in case a future caller starts
	// surfacing them (e.g. a synchronous "add to my clip now" flow that
	// fails fast instead of skipping).
	music_download_failed: "We couldn't add that music track. Please try again.",
	sfx_download_failed: "We couldn't add that sound effect. Please try again.",
	broll_download_failed: "We couldn't add that b-roll clip. Please try again.",
	checkout_failed: "We couldn't start checkout. Please try again.",
	social_publish_failed:
		"We couldn't publish to that platform. Please try again.",
	social_post_publish_failed:
		"We couldn't publish that post. Please try again.",
	social_platform_unsupported: "That social platform isn't supported yet.",
	social_provider_failed:
		"The platform rejected the upload. Please try again shortly.",
	social_account_missing:
		"That account is no longer connected. Reconnect it in Settings → Social, then schedule the post again.",
	social_asset_missing:
		"The rendered clip for this post is no longer available. Re-render the clip, then schedule it again.",
	social_post_schedule_failed:
		"We couldn't schedule that post. Check the account connection and try again.",
	review_approval_required:
		"This exact clip export needs approval before it can be scheduled.",
	review_override_forbidden:
		"Only a Workspace Owner or Admin can override review approval.",
	review_override_reason_invalid:
		"Add an override reason between 1 and 500 characters.",
	review_override_conflict:
		"This approval override changed. Start a new scheduling attempt.",
	review_export_not_found:
		"The exact clip export is no longer available. Refresh and choose the clip again.",
	review_approval_policy_invalid:
		"This project's approval policy is invalid. Reapply the Brand profile before publishing.",
	social_post_cancel_failed:
		"We couldn't cancel that post — it may have already started publishing. Check its current status above.",
	youtube_unsupported_source:
		"That link isn't a supported YouTube URL. Paste a youtube.com or youtu.be link.",
	youtube_missing_url:
		"No video link was provided. Paste a YouTube URL and try again.",
	link_missing_url: "No video link was provided. Paste a link and try again.",
	link_unsupported_source:
		"We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
	worker_command_timeout:
		"That step took too long and timed out. Please try again.",
	worker_command_failed:
		"We couldn't fetch that video. Make sure it's public and still available, then try again.",
	source_provider_access_denied:
		"The video provider refused this import. Upload the video file instead.",
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
	upload_presign_failed: "We couldn't prepare the upload. Please try again.",
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
	project_access_denied: "You don't have access to this project.",
	project_has_active_workflow:
		"This project has a run in progress. Wait for it to finish, then try deleting again.",
	project_has_active_publication:
		"Resolve the project's live or uncertain social publication before deleting it.",
	publication_frozen_media_missing:
		"The exact video frozen for this post is unavailable. Create a new scheduled post.",
	publication_media_preparation_failed:
		"The exact video for this post could not be prepared. Review the clip export and create a new scheduled post.",
	social_account_reconnect_required:
		"Reconnect the selected social account before creating a new scheduled post.",
	publication_capability_version_mismatch:
		"This post was prepared with an older publishing setup. Create a new scheduled post.",
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
	editor_boundaries_invalid:
		"That clip range is outside the editable source or duration limits. Choose a different start or end point.",
	editor_document_empty_timeline:
		"That edit would remove the entire clip. Keep at least one frame of footage.",
	retryable_contention:
		"This clip changed while you were editing it. Try saving your changes again.",
	persistence_unavailable:
		"Clip editing is temporarily unavailable. Please try again shortly.",
	clip_title_update_failed: "We couldn't rename this clip. Please try again.",
	clip_title_suggestion_failed:
		"We couldn't come up with title ideas just now. Please try again.",
	// Configuration, not a transient fault — telling someone to "try again" sends
	// them in a loop until an operator sets the key. Also thrown by the content
	// suite, which previously fell through to the generic message.
	openai_not_configured:
		"AI features aren't configured on this server yet. Add an OpenAI API key and try again.",
	openai_quota_exhausted:
		"Clip detection is paused because the OpenAI API account has no credits. Add credits, then retry detection.",
	openai_request_failed:
		"Our AI provider didn't respond. Please try again in a moment.",
	openai_bad_output:
		"The AI returned something we couldn't use. Please try again.",
	clip_duplicate_failed: "We couldn't duplicate this clip. Please try again.",
	clip_delete_failed: "We couldn't delete this clip. Please try again.",
	clip_storage_delete_incomplete:
		"Some clip media could not be deleted. The clip is still here, so try deleting it again.",
	clip_selection_invalid:
		"That selection is too close to the edge of the transcript to create a clip. Select a bit more and try again.",
	clip_create_from_selection_failed:
		"We couldn't create a clip from that selection. Please try again.",
	clip_has_scheduled_posts:
		"This clip has scheduled or publishing social posts. Cancel them in Publish, then delete the clip.",
	campaign_motion_target_missing:
		"This clip has no manual B-roll target. Add B-roll in Studio, then try again.",
	campaign_motion_document_limit:
		"This motion exceeds this clip's editing limits. Adjust the clip in Studio first.",
	scene_template_document_limit:
		"This scene exceeds this clip's editing limits. Adjust the clip in Studio first.",
	campaign_clip_stale:
		"This clip changed after selection. Refresh the project before retrying it.",
	campaign_clip_not_found:
		"This clip is no longer in the project. Refresh the project to update the selection.",
	// Extend as new codes appear.
};

export function hasUserErrorMessage(code: string): boolean {
	return Object.hasOwn(USER_ERROR_MESSAGES, code);
}

export function userErrorMessage(
	code: string | null | undefined,
): string | null {
	if (!code) return null;
	return (
		USER_ERROR_MESSAGES[code] ??
		"Something went wrong. Please try again or contact support."
	);
}
