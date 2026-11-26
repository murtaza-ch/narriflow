/** The shard that holds a design: its group, split by a stable hash of the id when the group is large. */
export function captionEmojiShardKey(id: string, group: string, count: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${group}-${count > 1 ? hash % count : 0}`;
}
