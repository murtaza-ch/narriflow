# Coalesced transfer gate preparation

Prepared locally. No database, Cloudflare, Modal or R2 action was performed for this checkpoint. The failed baseline and failed restore directories are unchanged. Transfer acceptance remains open.

`packages/services/scripts/executor-r2-batched-acceptance.ts` is a one-shot caller for the existing production fixture CLI and `verify_executor_r2_transfer` function. It refuses to start without a passed fresh 8/9/10 qualified-restore report, explicit epoch 10, an exact closed Worker version, and an exact hydrated Modal Function ID. Root supplies those facts only after the fresh restore passes. No launch configuration has been filled or executed.

The fixed new output directory is `/tmp/narriflow-executor-r2-batched`. The caller refuses existing fixture/report/notebook files and takes an exclusive run lock. It saves a private notebook before admission; the existing fixture CLI saves every intended UUID before mutation. Each admission window checks the exact isolated database, epoch and Worker, briefly opens only its own matching closed database epoch, and closes it in `finally`. HTTP stays closed. Signals close the caller's admission window; a hard kill still requires independent operator inspection.

The sequence is existing `seed-upload`, one actual upload invocation, existing `bind-pin` with real completed source-artifact/HEAD validation, then one actual conditional pin invocation. The real original SQL operation deadline caps every phase. The upload receipt may tighten it, and pin inherits it. No second 2700-second budget is created. Child calls have finite timeouts within that deadline. A lost SDK response is unconfirmed, never permission to resubmit or recreate the accepted operation.

Only the operator fixture subprocess receives the direct database URL. The native SDK caller receives only the existing bounded invocation, the pinned profile/environment and local SDK configuration. No database or long-lived R2 credential enters the native invocation or its environment. The caller checks the Modal Function ID before its sole remote submission. Private reports remain mode 0600. The notebook records fixed numeric timing aggregates and safe status fields, with no signed URL or body.

Local checks passed under Bun 1.3.6: combined qualified/large guard tests 9 tests and 77 assertions, services typecheck and focused Biome. Three controlled SDK-port Python tests verify exact function/environment selection, refusal before submission on identity change, and preservation of a failed report without retry. They do not call Modal. These tests establish caller behavior, not upload/pin speed, resource usage or deployed acceptance.

The new caller does no cleanup, bucket listing, deployment or account mutation. On failure, preserve its exact notebook and fixture journal for operator inspection and the existing known-key cleanup process. Terminating the local SDK child does not prove the remote invocation stopped.
