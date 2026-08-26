# Clip Composition Plan operations

Clip Composition Plan is the only video composition path for Studio preview and worker export. There are no renderer-selection, shadow, or compatibility modes.

The remaining environment values are analysis capability kill switches:

| Evidence | Studio (`apps/web/.env.local`) | Worker (`apps/worker/.env`) |
| --- | --- | --- |
| Automatic speakers | `NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT` | `WORKER_LAYOUT_ENGINE` |
| Explicit Split | `NEXT_PUBLIC_SPLIT_LAYOUT` | `WORKER_SPLIT` |
| Screen/PiP | `NEXT_PUBLIC_SCREEN_LAYOUT` | `WORKER_SCREEN_LAYOUT` |

Keep each public value aligned with its worker value. Disabling a capability does not select another renderer: the shared planner emits a typed notice and an explicit Center fallback plan.

## Deployment

1. Apply pending database migrations before deploying code that reads composition evidence.
2. Deploy the shared planner, Studio adapter, and worker adapter together.
3. Verify Center and Fit across all supported aspect ratios.
4. Verify Automatic with fresh, durable, unavailable, disabled, and target-ineligible evidence.
5. Verify Split with two speakers, insufficient faces, disabled analysis, and targets whose tiles cannot be distinct.
6. Verify Screen with confirmed PiP, face-band fallback, unavailable analysis, and disabled analysis.
7. Watch `clip_composition_plan` logs for plan version, fingerprint, effective modes, evidence source/version, evidence request count, and typed notice codes.

## Incident response

Use the narrow analysis kill switch for a failing detector and keep Studio's public mirror aligned. Center, Fit, plan validation, and FFmpeg composition remain active. Unknown plan versions fail before FFmpeg starts and must not be bypassed.
