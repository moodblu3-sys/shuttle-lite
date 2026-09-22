/**
 * File level and part level parallelism share one budget per process, as
 * required by docs/requirements.md section 5.
 */
export class Semaphore {
  #limit: number;
  #inUse = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get inUse(): number {
    return this.#inUse;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#inUse < this.#limit) {
      this.#inUse += 1;
      return this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#inUse += 1;
    return this.#release();
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse -= 1;
      const next = this.#waiters.shift();
      if (next) next();
    };
  }
}

/** Run tasks with a bounded number in flight, preserving result order. */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  semaphore?: Semaphore,
): Promise<R[]> {
  const gate = semaphore ?? new Semaphore(limit);
  const results = new Array<R>(items.length);
  await Promise.all(
    items.map((item, index) =>
      gate.withPermit(async () => {
        results[index] = await fn(item, index);
      }),
    ),
  );
  return results;
}
