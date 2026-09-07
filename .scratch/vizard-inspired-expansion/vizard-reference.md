# Vizard reference and Narriflow overlap audit

**Observed:** 26 August 2026 in the logged-in Vizard workspace `What's new` modal.

This appendix records product behavior used as inspiration. It does not require visual matching or exact feature parity.

## References used by this program

| Vizard release entry | Observed behavior | Narriflow baseline | Adaptation in this program |
| --- | --- | --- | --- |
| July 2026, `Auto Censorship` | Detects sensitive words, replaces audio with beep or silence, and lets users manage a custom word library. | Source audio can be muted as a whole, but there is no timed censor model or review flow. | Suggestion-first timed censoring with beep, mute, and caption masking. Brand Profiles supply blocked terms. |
| 22 June 2026, `Subtitle line editing and scene insertions with bulk intro automation` | Inserts hooks, intros, and outros from the timeline or transcript. Templates can apply an intro to many clips. | Subtitle merge, split, add, edit, and delete already exist. The Clip Composition Plan has scenes internally, but users cannot insert scene blocks. | Keep subtitle editing unchanged. Add bounded scene blocks and reusable intro or outro Scene Templates through the shared composition plan. |
| 6 March 2026, `Generate Motion Graphics, Videos, and Images in the Editor` | Generates motion graphics, images, or video, then inserts the result on the timeline. | Studio searches stock B-roll and accepts a manual URL. It does not own generated visual assets. | Generate still images first, then short video. Save outputs as Visual Assets and insert them through the existing media and composition path. |
| 12 January 2026, `Animations & Mobile Access` | Adds animations to B-roll and images. | Narriflow has caption animations but no general media entrance or exit motion. | Add a bounded animation model for scene media, B-roll, and text cards. Mobile access is out of scope. |
| 4 December 2025, `Meet the new Editor & Transitions` | Adds transitions, a right-side editor panel, separate upload and B-roll panels, contextual tools, and Brand Kit access. | Narriflow already has a right-side Inspector, B-roll, Brand Template access, and Cut, Fade, Fade to Black, and Dip White. | Keep the Studio shell. Add transition types and media motion through the current Inspector and shared composition plan. |
| 14 November 2025, `Bulk Schedule Clips + Clip Again` | Selects several project clips and schedules them together. Also regenerates clips from a prompt. | Narriflow can prompt re-clip and schedule posts, but only Render selected is exposed as a project bulk action. | Keep prompt re-clipping. Add selection-scoped scheduling and campaign operation results. |
| 28 July 2025, `Bulk schedule and post videos` | Selects videos and accounts, sets frequency and time ranges, and generates descriptions and hashtags. | Narriflow has a Calendar and connected social accounts. It lacks one selected-clip scheduling flow and assisted platform copy. | Add bulk scheduling to the Clips flow and generate editable, platform-specific copy from Brand Profile guidance. |
| 22 May 2025, `Bulk export and download` | Selects clips, exports them, and downloads them in one operation. | Narriflow renders selected clips but downloads export variants one at a time. | Reuse immutable Clip Exports and the existing `export_bundle` stage for asynchronous ZIP delivery. |
| 23 January 2025, `Introducing the Social Media Calendar` | Manages TikTok, YouTube, Instagram, LinkedIn, X, and Facebook accounts. Supports custom thumbnails on selected providers. | Narriflow already has Calendar and TikTok, YouTube Shorts, Instagram Reels, LinkedIn, and X publishing. | Add Facebook and a provider capability matrix for thumbnails. Keep the current Calendar and social lifecycle. |
| 7 November 2024, `Custom Fonts Now Available in Vizard Brand Kit!` | Uploads TTF and OTF files and makes them available across projects. | Narriflow supports built-in caption fonts but no workspace font asset. | Add licensed Brand Fonts with validated upload, preview, render resolution, deletion rules, and Brand Profile ownership. |
| 16 October 2024, `Brand kit` | Centralizes logos, colors, templates, subtitle presets, text presets, and shared team access. | Narriflow has Brand Templates with caption style, logo, and colors, plus a separate audio asset library. | Add Brand Profiles around compatible templates and aggregate visual, audio, scene, font, and voice guidance in one Brand Kit experience. |
| 14 August 2024, `New Feature: Share Your Entire Project for Preview` | Shares a project and all its clips with external viewers. | Narriflow shares one immutable Clip Export per revocable link. It has no project-level review or decisions. | Add Review Rounds over selected immutable exports, guest identity, timecoded comments, decisions, and approval gates. |
| 25 July 2024, `Team Workspace` | Shares previews without sign-up and describes future comments, version control, and notifications. | Narriflow has owner, admin, editor, and viewer workspace roles. | Keep internal roles and add secure guest review access without creating guest workspace members. |

## Existing Vizard patterns deliberately excluded

- Vizard's July 2026 clipping model entry overlaps Narriflow's context-aware moment detection, virality scoring, tags, and reasoning.
- The June 2026 subtitle line tools overlap Narriflow's current subtitle editing.
- The January 2026 audio and processing-range entry overlaps Narriflow's music, sound effects, uploads, volume, timing, and processing range.
- The December 2025 folders entry overlaps Narriflow folders.
- The November 2025 `Clip Again` flow overlaps prompt-based re-clipping.
- The May 2025 direct Instagram entry overlaps Narriflow's current Instagram Reels OAuth and publishing.
- The 2024 custom B-roll entry overlaps Narriflow's current stock and manual B-roll editing enough that this program only adds reusable and generated visual assets.
- Mobile applications and Google Drive delivery remain outside this program.

