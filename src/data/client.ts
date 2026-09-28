import { loadDataFiles } from "./load-files.mjs";
import type { DataSet, Inspection } from "./types";

let pending: ReturnType<typeof loadDataFiles> | undefined;

export function loadData(
  progress: (message: string) => void,
  initialRestaurantId?: string | null,
): Promise<DataSet> {
  progress("Loading restaurant summaries…");
  pending ??= loadDataFiles(
    `${import.meta.env.BASE_URL}data/`,
    undefined,
    initialRestaurantId,
  ).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending.then((snapshot) => snapshot.data);
}

export async function getInspections(id: string): Promise<Inspection[]> {
  if (!pending) throw new Error("Restaurant summaries are still loading.");
  return (await pending).getInspections(id);
}

/** Intent prefetch is bounded by the same shard/result caches as normal clicks. */
export function prefetchInspections(id: string) {
  void getInspections(id).catch(() => {});
}
