export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const size = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failure: unknown;

  async function consume(): Promise<void> {
    while (true) {
      if (failure || shouldStop?.()) {
        return;
      }

      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => consume()),
  );

  if (failure) {
    throw failure;
  }

  return results;
}
