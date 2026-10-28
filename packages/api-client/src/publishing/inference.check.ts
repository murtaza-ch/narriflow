/**
 * Compile-time proof that the publishing routes keep their input and output
 * types through `import type`: a read, a retryable mutation and the OAuth
 * start. Type-checked, never executed.
 */
import type { PublishingClient } from "./index";
import { publishingCommands } from "./mutations";
import { publishingReads } from "./queries";

export async function publishingInference(client: PublishingClient) {
  const queue = await publishingReads(client).queue();
  const timezone: string = queue.timezone;
  const canManage: boolean = queue.canManage;
  // @ts-expect-error the timezone is a string, not a number
  const wrongTimezone: number = queue.timezone;

  const commands = publishingCommands(client);
  const started = await commands.startSocialOAuth("tiktok");
  const authorizationUrl: string = started.authorizationUrl;
  // @ts-expect-error an unknown platform is refused by the shared schema type
  await commands.startSocialOAuth("myspace");

  // @ts-expect-error a proposal needs its export
  await commands.propose({ clipId: "c", socialAccountId: "a" }, "key");
  // @ts-expect-error a retryable command cannot be sent without its idempotency key
  await commands.propose({ clipId: "c", exportId: "e", socialAccountId: "a" });

  return { timezone, canManage, wrongTimezone, authorizationUrl };
}
