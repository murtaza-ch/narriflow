# Apple Park clip framing comparison

Reviewed the authenticated [Vizard project](https://vizard.ai/project/34356248) and the [local Narriflow project](http://localhost:3000/projects/24a05f24-e968-40f2-8256-fe2d80de390c) on September 14, 2026. Both have ten clips, but their selections and boundaries differ. Eight subjects overlap. Vizard additionally selected hidden stair rails and glass cleaning; Narriflow selected studio ideas and underground parking.

The comparison uses rendered video, source frames, stored automatic-layout evidence, and the implementation. Vizard's internal model and decision rules are unknown. Statements about Vizard below describe visible output, not a claim about its architecture. Browser playback was sampled at two-second intervals throughout every Vizard clip, with additional settled frames around changes. Every existing Narriflow render was inspected alongside the source and detector output. This is a framing review, not a frame-by-frame human annotation or an assessment of clip selection quality.

## What the camera terms mean

- **Shot boundary:** a cut already present in the source, such as a switch from both hosts to one host. A crop must reset at that cut instead of sliding across unrelated views.
- **Reframing:** choosing the portion of a landscape image that appears in a portrait output.
- **Tracking:** moving that crop within the same shot as a person moves. Small movements need a quiet zone and smoothing to prevent jitter.
- **Two-up layout:** two crops of the same source frame, stacked vertically, with one visible person in each tile.
- **Active-speaker switching:** choosing a person based on who is speaking. Audio diarization identifies voices; it does not by itself identify which visible face belongs to each voice.
- **Fit:** retaining the entire source image, useful for diagrams, slides, articles, and uncertain scenes.

Vizard usually follows source camera cuts and holds two-up through changes of speaker. It uses tight face crops, sometimes switches graphics to fit with a blurred background, and sometimes crops graphics so their text is lost. Narriflow's existing output had a more fundamental problem: a circular studio poster was repeatedly detected as a face. It could be larger than the real face in detector coordinates, so layout selection gave it a tile or centered between it and a person. Static crop centers then could not follow a person leaning away.

## Every Vizard clip

Times are relative to that Vizard clip, not to the original source. The last seconds of many clips contain Vizard's branded outro.

| Clip | Visible sequence and framing | Assessment and corresponding Narriflow clip |
| --- | --- | --- |
| 1. The best hidden feature at Apple Park, 41.2s | Black/green-shirt hosts in two-up; cropped title around 2s; stair rail details at 8–14s; moving on-location host at 16–24s; rail detail at 26–30s; blue/denim hosts in two-up at 32–38s. | Useful mix of detail shots and people. Title cropping loses context. No matching Narriflow selection. |
| 2. Is the Steve Jobs Theater safe?, 41.4s | Cropped question/title at 0–4s; roof/glass footage at 6–16s; two-up at 18–20s; complete article in a fit layout at 22–24s; two-up at 26–34s; denim-shirt host alone at 36–38s. | Fit preserves the article's structure, although text is small. Compare Narriflow's Glass Roof clip only over the overlapping source window. |
| 3. Taking a Surface Laptop into Apple HQ, 71.2s | Laptop shot; blue/denim two-up; black/green two-up; Tim Cook interview at 14–18s; alternating black-shirt solo and black/green two-up through 68s. | Follows source editing without cutting at every speech turn. At about 60s and 64s, the laughing green-shirt host leaves much of the bottom crop. Compare Tim Cook Phone Situation. |
| 4. Can you get into Apple Park?, 33.6s | Title, map, photos and merchandise mostly fit with blurred padding through 22s; black/green two-up at 24–28s; group event image at 30s. | Strongest reference for preserving informational inserts. Compare How You Get Into Apple Park. |
| 5. The food at Apple Park is incredible, 45.4s | Two-up opening; cropped title; question cards fit at 4–6s; blue/denim two-up at 8–24s; green-shirt solo at 26–40s; two-up at 42s. | Holds the source composition through speech turns. Compare Cafeteria Lunch System, whose selection ends earlier. |
| 6. Where is the AC in the Steve Jobs Theater?, 41.3s | Black/green two-up at 0–4s; black-shirt solo at 6s; crop showing the set poster at about 8.1s; two-up; vent details at 12–16s; two-up; window/wire details at 28–32s; two-up; green-shirt solo. | The poster crop is a visible failure, regardless of its internal cause. Detail inserts need their own framing. Compare AC Comes Out of the Floor. |
| 7. The worst hotel Wi-Fi story, 63.7s | Denim-shirt solo; two-up briefly has the top host bent down; production footage at 6–14s; extended blue/denim two-up at 16–40s; studio footage at 42–48s; two-up; denim solo. | Good restraint during conversation; leaning can expose empty tile area. Compare Gigabit Wi-Fi That Wasn't over its shorter selection. |
| 8. The famous Apple Park pizza box, 41.9s | Black/green opening; blue/denim two-up; denim solo; poster-heavy crop around 14.0s with blue-shirt host off the edge; two-up; article fit at 24–26s; blue-shirt solo; two-up. | Article preservation is useful; the empty/person-off-edge crop is not a target to copy. Compare Pizza Box Venting Trick. |
| 9. How does Apple clean all that glass?, 40.1s | Cropped question/title; cleaning/glass footage; on-location two-up; studio two-up; blue-shirt solo; glass decal footage at 30–36s. | Keeps topical B-roll in sequence but loses some title text. No matching Narriflow selection. |
| 10. How bad is the Wi-Fi at tech events?, 34.3s | Cropped question; blue-shirt solo; blue/denim two-up; handheld event/laptop/crowd footage at 12–18s as a single view; two-up; phone speed test at 28–30s. | Does not turn the incidental crowd into duplicated speaker tiles. Compare Apple Park Wi-Fi Story. |

## Narriflow findings and acceptance criteria

Narriflow indexes below follow source order, not gallery score order. All ten began with automatic framing and no manual scene or speaker overrides.

| Index and clip | Original source window | Specific requirement |
| --- | --- | --- |
| 0. How You Get Into Apple Park | 00:08.210–00:35.113 | Preserve visitor map, photos and merchandise; return to real host framing at source cuts. |
| 1. Steve Jobs Theater's Glass Roof | 02:16.894–02:44.402 | Preserve roof/glass inserts and article rather than inheriting a host's crop. |
| 2. The AC Comes Out of the Floor | 03:09.818–03:31.280 | Reject the poster face; show vent detail completely; distinguish solo source shots from two-person shots. |
| 3. The Apple Park Wi-Fi Story | 04:07.500–04:40.836 | Keep event/laptop footage coherent and prevent incidental faces from creating spurious two-up scenes. |
| 4. The Gigabit Wi-Fi That Wasn't | 05:07.255–05:44.862 | Hold the true blue/denim host pair; preserve studio inserts; do not promote the set poster. |
| 5. The Tim Cook Phone Situation | 06:12.840–07:17.488 | Follow source close-up/wide cuts; reject poster crops; track leaning hosts without tile swaps or pans across source cuts. |
| 6. What the Studio Should Steal From Apple Park | 07:33.960–08:03.002 | Keep conversation framing stable while retaining inserts. No Vizard selection of this topic. |
| 7. Parking Goes Underground at Apple Park | 08:30.957–09:04.385 | Preserve location/context shots and avoid person crops based on uncertain detections. No Vizard selection of this topic. |
| 8. The Apple Park Cafeteria Lunch System | 09:31.134–10:04.083 | Preserve the question card; frame the actual host pair instead of including the poster. |
| 9. The Apple Pizza Box Venting Trick | 10:52.107–11:16.350 | Preserve the article/box illustration and use source solo shots without empty-chair or poster tiles. |

The local original is only 640×338 pixels. Its Studio proxy is upscaled to 1022×540, and existing exports are 720×1280. Upscaled proxy dimensions must not be treated as evidence of more source detail. Stronger zoom can produce a closer face, but cannot recover detail that the original does not contain. This also limits any sharpness comparison with Vizard, whose ingested source quality is not observable here.

The source/proxy timeline was checked: the proxy has the expected four-second lead-in, and corresponding cuts agree to about 10ms on the Wi-Fi and Tim Cook clips. The bad crops were not caused by that offset.

## Implemented behavior

Automatic layout now stores version 3 (`shot-layout-v3`) camera tracks. The shared composition plan converts those normalized tracks into crops; Studio and FFmpeg interpolate the same path on the edited timeline. Manual speaker overrides take precedence.

The changes address the observed failures:

- New face tracks require confidence of at least 0.85. Weaker detections can continue a nearby, recently admitted track. Known source cuts reset admission, so an unrelated face cannot inherit confidence across a cut. This rejects the observed poster detections without dropping every weaker profile frame of a real host.
- Within each shot, the crop follows the last accepted face with position and size checks. A dead zone suppresses detector jitter, and faster movement gets a quicker response. Zoom stays constant within the shot. Track reduction preserves the last actual observation.
- Every supplied source cut remains a boundary. Auxiliary face discontinuities are debounced separately. Crop tracks do not sample the next shot or interpolate across a cut.
- Automatic two-up requires two supported, simultaneously visible subjects. Crowd evidence is assessed across the original source shot before detector-derived subdivisions. A crowd cannot become a solo or two-person layout merely because its faces form fewer lateral clusters. Crowded shots, unsupported multi-face shots, and no-face shots use full-source fit; explicit scene-layout subjects remain available for manual choices.
- Automatic zoom uses one conservative cap in both proxy analysis and source rendering. The upscaled proxy can no longer receive a larger crop zoom just because it has more pixels.

This is a deterministic framing improvement, not a semantic guarantee that a detector can distinguish every photograph, reflection, poster, or person. It also does not establish reliable voice-to-face identity from diarization alone. The default keeps supported two-person source shots through speech turns. Fit preserves content with black padding in the reviewed configuration; it does not reproduce Vizard's blurred background.

## Verification

The final code passes `bun run lint`, `bun run typecheck`, and `bun run test`. The fast suites report 2,550 passing tests and 200 skips. The skips include PostgreSQL suites; disposable-schema DB gates were not run for this change. Lint exits successfully with existing warnings in unrelated home-page CSS and the generated architecture report, plus an existing unnecessary-fragment notice.

The added regression coverage includes false-positive admission and weaker real-face continuation, movement across more than 45% of the source width, crowded scenes, source-cut preservation, final tracking samples, full-source fit, manual override precedence, and shared preview geometry. A real FFmpeg test renders a moving crop over a three-band source, then decodes frames at 2.1, 2.5, and 3.1 seconds. It verifies the expected red → green → blue positions using the shared preview interpolation, including a scene starting at 2 seconds.

## Final local-project results

All ten ordinary 9:16 exports were refreshed through the normal render implementation and the scoped Workflow Run lifecycle: **10 succeeded, 0 failed**. Their saved analysis is `shot-layout-v3` against the actual 640×338 source. The downloaded final exports were inspected at two-second intervals across every clip, with targeted checks of the previously failing shots. Editor revisions, Studio edits, deleted ranges, and source windows match the baseline. The local worker was resumed after the refresh.

The baseline segment counts below describe the old v2 plan. A lower count is not itself a quality score: removing false detections reduces unnecessary subdivisions, while preserving a real source cut can increase the count.

| Index | Original segments | Final segments | Fit segments | Two-up segments | Final visual check |
| --- | ---: | ---: | ---: | ---: | --- |
| 0 | 4 | 8 | 6 | 2 | Visitor map, question card, photos and merchandise retained; the host pair returns at the source cut. |
| 1 | 8 | 8 | 5 | 3 | Roof/glass footage and article retained; supported studio shots remain two-up. |
| 2 | 11 | 6 | 2 | 3 | The sampled poster-only tiles are removed; source close-ups and vent inserts remain distinct. |
| 3 | 22 | 11 | 3 | 4 | Question and speed-test screens fit; event footage stays a single view instead of duplicated crowd tiles. |
| 4 | 23 | 12 | 4 | 5 | Host pair is retained; the moving studio/group insert uses complete framing where the scene contains a crowd. |
| 5 | 24 | 14 | 0 | 7 | The sampled poster-only tiles are removed; the close-ups track the actual host and the leaning listener remains in the wide tiles. |
| 6 | 14 | 7 | 1 | 4 | Question graphic fits; source close-ups and the real host pair retain their sequence. |
| 7 | 13 | 11 | 6 | 1 | Map and location inserts fit; the complete outdoor group stays visible across the auxiliary face-count boundary at 32.232s. |
| 8 | 13 | 8 | 1 | 3 | Question card fits; true host pairs and source solo shots are retained. |
| 9 | 8 | 10 | 3 | 4 | The complete pizza-box article is retained, followed by the source solo/two-person sequence. |

Studio playback was checked on the Tim Cook clip. During the close-up, the video crop's horizontal offset changed while width and height remained fixed, as intended. This complements the decoded FFmpeg parity test; it is not a claim that two independent HTML video players have frame-perfect synchronization.

The strongest demonstrated improvements are rejection of the set-display crops, preservation of complete informational inserts, movement within source shots, and keeping the outdoor group together. Vizard remains a useful aesthetic reference for tighter face presentation and blurred padding. These clips do not prove universal superiority over Vizard or perfect framing on unseen footage.

Local review evidence is under `/tmp/narriflow-framing-review/`: `evidence.json` and `renders/` preserve the original Narriflow baseline; `vizard-screens/` and `vizard-sheets/` hold the browser survey; `final/evidence.json`, `final/contacts/`, and `final/0.mp4` through `final/9.mp4` hold the refreshed results. Temporary files are not part of the repository. The refreshed clips are available in the linked local project.

