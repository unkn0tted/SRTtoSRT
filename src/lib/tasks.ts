export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => consume()),
  );

  return results;
}
