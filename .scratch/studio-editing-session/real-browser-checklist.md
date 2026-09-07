# Studio Editing Session real-browser checklist

Use a signed-in Chromium profile and one real clip with source media and a
generated proxy. Record the clip URL, browser version, date, and outcome for
every release candidate. These checks complement the deterministic session and
adapter tests; they do not replace them.

## Device Draft recovery

- Make a visible edit and wait for the save indicator to leave `Saving`.
- Disable the network, make a second visible edit, then close the tab without
  restoring connectivity.
- Reopen the same Studio URL in the same browser profile.
- Confirm the Device Draft is recovered, the offline edit is visible, and the
  recovery notice appears without an editable cloud/device conflict.

## Cooperative multi-tab takeover

- Open the same Studio URL in two tabs in the same browser profile.
- Confirm the first tab is writable and the second is readable but cannot edit.
- Make an edit in the writer, then choose **Take over editing** in the reader.
- Confirm the outgoing tab checkpoints and becomes read-only, the incoming tab
  reloads device and cloud state before becoming writable, and the outgoing
  edit is present in the new writer.

## Forced multi-tab takeover

- Open the same Studio URL in two tabs and make the first tab the writer.
- In browser developer tools, pause JavaScript execution in the writer so it
  cannot answer a handoff request.
- Choose **Take over editing** in the reader and wait longer than two seconds.
- Confirm the reader becomes the writer through forced takeover, refreshes the
  cloud/device baseline, and the paused tab cannot overwrite the new writer
  after execution resumes.

## Disabled storage and coordination

- In a disposable browser profile, block IndexedDB/local storage for the site
  and disable Web Locks/BroadcastChannel with developer-tool overrides.
- Open Studio and confirm it remains editable through degraded coordination.
- Confirm the save UI communicates degraded local recovery and cloud revision
  fencing still prevents a stale writer from silently winning.

## Offline sync

- With Studio writable and initially current, switch the browser network to
  Offline and make several edits.
- Confirm the Device Draft becomes durable and the UI reports offline state.
- Restore the network and confirm exactly the latest Clip Editor Document is
  checkpointed without overlapping or out-of-order visible saves.

## Proxy replacement

- Start from a clip with an eligible proxy, then commit a boundary trim.
- Confirm the proxy is rejected immediately, source media becomes active, and
  playback remains usable while a replacement is pending.
- When the matching replacement arrives, confirm Studio adopts it without
  jumping to a different source frame; stale proxy/layout responses stay
  ignored.

## Source-anchored playback

- Seek to a recognizable source frame, play, pause, change rate, and trim around
  the playhead.
- Confirm the same kept source frame is preserved across source/proxy swaps.
- Delete the current frame and confirm playback moves to the next kept frame;
  delete at the tail and confirm it parks on the final kept frame.
- Confirm play/pause state and playback rate survive an eligible media swap.

## Verification record

Record each run as a dated table with columns `Scenario`, `Result`, and `Notes`.
Do not mark a scenario passed unless every confirmation in that section was
observed in the real browser.

### 2026-08-15 — ticket 07

URL: `http://localhost:3000/projects/4279f13d-5341-45ab-b164-69d65dd3362b/clips/094d664c-d838-4a99-8d66-7e82e4455443/studio`

| Scenario | Result | Notes |
| --- | --- | --- |
| Cooperative multi-tab takeover | Pass | The second tab opened read-only, takeover made it the sole writer, and the outgoing tab immediately showed read-only safety mode. |
| Forced multi-tab takeover | Pass | JavaScript was paused in the writer; the reader acquired ownership after the two-second timeout. Resuming the old writer left it fenced and produced a structured `stale` handoff diagnostic with project, clip, session, document, cloud-revision, and ownership identifiers. |
| Read-only playback | Pass | The fenced tab started and paused playback while remaining read-only. |
| Browser console | Pass | No application errors. Only Clerk's expected development-key warning was present. |
| Device Draft recovery | Not run | Covered by the checklist above and deterministic session tests; this ticket's live run was scoped to multi-tab takeover. |
| Disabled storage and coordination | Not run | Covered by the checklist above and deterministic adapter/session tests. |
| Offline sync | Not run | Covered by the checklist above and deterministic session tests. |
| Proxy replacement | Not run | Covered by the checklist above and deterministic session tests. |
| Full source-anchored playback matrix | Not run | Read-only playback was exercised; cut/tail/media-swap cases remain in deterministic session tests. |
