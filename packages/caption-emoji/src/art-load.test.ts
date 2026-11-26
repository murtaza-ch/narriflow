import { expect, test } from "bun:test";
import { SHARD_LOADERS } from "./generated/shards";

// A fresh copy of the art module: the shared one caches every shard once the other art tests have loaded them.
const fresh = "shard-failure";
const { loadCaptionEmojiArt } = (await import(`./art?${fresh}`)) as typeof import("./art");

test("a shard that fails to load drops only its own ids, and is asked again next time", async () => {
  const loaders = SHARD_LOADERS as Record<string, () => Promise<{ default: string }>>;
  const real = loaders["smileys-0"]!;
  let calls = 0;
  loaders["smileys-0"] = () => {
    calls++;
    return Promise.reject(new Error("chunk failed"));
  };
  try {
    // heart-eyes is a smiley; rocket is in travel-and-places.
    const art = await loadCaptionEmojiArt(["heart-eyes", "rocket"]);
    expect([...art.keys()]).toEqual(["rocket"]);
    loaders["smileys-0"] = () => {
      calls++;
      return real();
    };
    const again = await loadCaptionEmojiArt(["heart-eyes", "rocket"]);
    expect([...again.keys()].sort()).toEqual(["heart-eyes", "rocket"]);
    expect(calls).toBe(2);
  } finally {
    loaders["smileys-0"] = real;
  }
});
