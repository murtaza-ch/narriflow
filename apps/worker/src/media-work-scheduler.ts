/** One CPU lane. Waiting renders get the next slot; one waiting background job
 * runs between groups, with FIFO fairness among preview/layout/thumbnail work. */
export class MediaWorkScheduler {
  private active: "render" | "background" | null = null;
  private last: "render" | "background" | null = null;
  private readonly pending: Array<{ kind: "render" | "background"; name: string; at: number; signal: AbortSignal; start(): void; cancel(): void }> = [];

  snapshot() {
    return { active: this.active, waiting: this.pending.map(({ kind, name, at }) => ({ kind, name, ageMs: Date.now() - at })) };
  }

  run<T>(kind: "render" | "background", name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const entry = { kind, name, at: Date.now(), signal,
        start: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active = kind;
          void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => {
            this.active = null;
            this.last = kind;
            // Give the render loop resuming after this group a chance to enqueue.
            queueMicrotask(() => this.drain());
          });
        },
        cancel: () => {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.pending.push(entry);
      signal.addEventListener("abort", entry.cancel, { once: true });
      queueMicrotask(() => this.drain());
    });
  }

  private drain(): void {
    if (this.active || this.pending.length === 0) return;
    const preferred = this.last === "render" ? "background" : "render";
    const index = this.pending.findIndex((entry) => entry.kind === preferred);
    this.pending.splice(index < 0 ? 0 : index, 1)[0]!.start();
  }
}
export const mediaWorkScheduler = new MediaWorkScheduler();
