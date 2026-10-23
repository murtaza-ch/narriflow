export type Path = Array<string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getIn(tree: unknown, path: Path): unknown {
  let node = tree;
  for (const key of path) {
    if (Array.isArray(node)) node = node[key as number];
    else if (isRecord(node)) node = node[key as string];
    else return undefined;
  }
  return node;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

/** Immutably sets a value; `undefined` removes it, and objects left empty disappear with it. */
export function setIn(tree: unknown, path: Path, value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (typeof key === "number") {
    const list = Array.isArray(tree) ? [...tree] : [];
    const next = setIn(list[key], rest, value);
    if (next === undefined && rest.length === 0) list.splice(key, 1);
    else list[key] = next;
    return list;
  }
  const record = isRecord(tree) ? { ...tree } : {};
  const next = setIn(record[key], rest, value);
  if (isEmpty(next) && rest.length > 0) delete record[key];
  else if (next === undefined) delete record[key];
  else record[key] = next;
  return Object.keys(record).length ? record : undefined;
}

/** The example body with what the visitor entered laid over it. */
export function overlay(sample: unknown, entered: unknown): unknown {
  if (entered === undefined) return sample;
  if (isRecord(sample) && isRecord(entered)) {
    const merged: Record<string, unknown> = { ...sample };
    for (const [key, value] of Object.entries(entered)) merged[key] = overlay(sample[key], value);
    return merged;
  }
  return entered;
}
