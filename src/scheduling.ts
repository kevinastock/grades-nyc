/** Let pending browser work run between independent startup tasks. */
export function yieldToBrowser(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield(): Promise<void> };
    }
  ).scheduler;
  return scheduler?.yield
    ? scheduler.yield()
    : new Promise<void>((resolve) => setTimeout(resolve, 0));
}
