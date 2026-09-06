export type StudioKeys<Fields extends object> = readonly [
  keyof Fields,
  ...(keyof Fields)[],
];

export interface StudioSelection<Value> {
  getSnapshot(): Value;
  getServerSnapshot(): Value;
  subscribe(listener: () => void): () => void;
}

export interface StudioAccess<Fields extends object> {
  select<const Keys extends StudioKeys<Fields>>(
    keys: Keys,
  ): StudioSelection<Readonly<Pick<Fields, Keys[number]>>>;
}

export interface StudioAccessSource<Fields extends object> {
  access: StudioAccess<Fields>;
  publish(fields: Fields): void;
}

function selectFields<
  Fields extends object,
  const Keys extends StudioKeys<Fields>,
>(fields: Fields, keys: Keys): Readonly<Pick<Fields, Keys[number]>> {
  const selection = {} as Pick<Fields, Keys[number]>;
  for (const key of keys) selection[key] = fields[key];
  return selection;
}

function selectedFieldsEqual<
  Fields extends object,
  const Keys extends StudioKeys<Fields>,
>(
  left: Readonly<Pick<Fields, Keys[number]>>,
  right: Readonly<Pick<Fields, Keys[number]>>,
  keys: Keys,
): boolean {
  return keys.every((key) => Object.is(left[key], right[key]));
}

export function createStudioAccess<Fields extends object>(
  initialFields: Fields,
): StudioAccessSource<Fields> {
  let currentFields = initialFields;
  const activeSelections = new Set<{ refresh(fields: Fields): void }>();
  const selectionCache: Array<{
    keys: readonly (keyof Fields)[];
    selection: StudioSelection<unknown>;
  }> = [];

  const access: StudioAccess<Fields> = {
    select: <const Keys extends StudioKeys<Fields>>(keys: Keys) => {
      if (keys.length === 0) {
        throw new Error("StudioAccess.select requires at least one field");
      }
      const cached = selectionCache.find(
        (entry) =>
          entry.keys.length === keys.length &&
          entry.keys.every((key, index) => Object.is(key, keys[index])),
      );
      if (cached) {
        return cached.selection as StudioSelection<
          Readonly<Pick<Fields, Keys[number]>>
        >;
      }

      const serverSnapshot = selectFields(initialFields, keys);
      let snapshot = serverSnapshot;
      const subscriptions = new Set<{ listener: () => void }>();

      const selection = {
        refresh(fields: Fields) {
          const next = selectFields(fields, keys);
          if (selectedFieldsEqual(snapshot, next, keys)) return;
          snapshot = next;
          for (const subscription of [...subscriptions]) {
            subscription.listener();
          }
        },
        getSnapshot() {
          if (subscriptions.size === 0) selection.refresh(currentFields);
          return snapshot;
        },
        getServerSnapshot: () => serverSnapshot,
        subscribe(listener: () => void) {
          if (subscriptions.size === 0) {
            selection.refresh(currentFields);
            activeSelections.add(selection);
          }
          const subscription = { listener };
          subscriptions.add(subscription);

          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            subscriptions.delete(subscription);
            if (subscriptions.size === 0) activeSelections.delete(selection);
          };
        },
      } satisfies StudioSelection<
        Readonly<Pick<Fields, Keys[number]>>
      > & { refresh(fields: Fields): void };

      selectionCache.push({ keys: [...keys], selection });
      return selection;
    },
  };

  return {
    access,
    publish(fields) {
      currentFields = fields;
      for (const selection of [...activeSelections]) selection.refresh(fields);
    },
  };
}
