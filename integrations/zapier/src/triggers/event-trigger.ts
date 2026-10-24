import { defineTrigger, type Bundle, type PlainOutputField, type ZObject } from 'zapier-platform-core';
import { recentEvents, type WorkspaceEvent } from '../events';

export const EVENT_FIELDS: PlainOutputField[] = [
  { key: 'id', label: 'Event ID' },
  { key: 'eventType', label: 'Event Type' },
  { key: 'occurredAt', label: 'Occurred At' },
  { key: 'details__available', label: 'Details Available (false when the project, clip or export was deleted)', type: 'boolean' },
];

type Hydrator = (z: ZObject, bundle: Bundle) => Promise<unknown>;

export interface EventTriggerSpec<Subject> {
  key: string;
  noun: string;
  label: string;
  description: string;
  /** Sent to GET /events as `types`. */
  types: readonly string[];
  /** Narrows the types to the outcomes this trigger is named for. */
  accept: (event: WorkspaceEvent<Subject>) => boolean;
  /** Fields that come straight from the event's subject, with no read. */
  fields: (subject: Subject) => Record<string, unknown>;
  /** What the `details` field reads, once Zapier needs it: a hydrator and the IDs to give it. */
  details: { hydrator: Hydrator; input: (subject: Subject) => Record<string, unknown> };
  sample: { id: string } & Record<string, unknown>;
  outputFields: PlainOutputField[];
}

/**
 * A polling trigger over `GET /events`: one request for the newest events. Each
 * item's `id` is the event ID, which is unique per terminal transition, so
 * Zapier's own deduplication delivers every event once however many polls return
 * it. The reads that make an item useful (project title, clips, export) sit
 * behind `z.dehydrate`, so Zapier makes them only for events it has not seen.
 */
export function eventTrigger<Subject>(spec: EventTriggerSpec<Subject>) {
  return defineTrigger({
    key: spec.key,
    noun: spec.noun,
    display: { label: spec.label, description: spec.description },
    operation: {
      type: 'polling',
      perform: async (z, bundle) => {
        const events = await recentEvents<Subject>(z, bundle, spec.types, spec.accept);
        return events.map((event) => ({
          id: event.id,
          eventType: event.type,
          occurredAt: event.occurredAt,
          ...spec.fields(event.subject),
          details: z.dehydrate(spec.details.hydrator, spec.details.input(event.subject)),
        }));
      },
      sample: spec.sample,
      outputFields: [...EVENT_FIELDS, ...spec.outputFields],
    },
  });
}
