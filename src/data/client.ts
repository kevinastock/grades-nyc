import { decodeSummaryBytes, loadDataFiles } from "./load-files.mjs";
import { decodeRestaurantColumns } from "./manifest.mjs";
import { ExplorerClient } from "./explorer-client";
import type { DataSet, Inspection, Restaurant } from "./types";
import { yieldToBrowser } from "../scheduling";

let pending: ReturnType<typeof loadDataFiles> | undefined;
let createExplorerData:
  Awaited<ReturnType<typeof loadDataFiles>>["createExplorerData"] | undefined;
let preparedExplorer: ExplorerClient | undefined;
let cancelPreparation: (() => void) | undefined;

export function loadData(
  progress: (message: string) => void,
  initialRestaurantId?: string | null,
): Promise<DataSet> {
  progress("Loading restaurant summaries…");
  if (!pending) {
    // Start module evaluation while the snapshot downloads. The prepared worker
    // will become the app's normal explorer after loading, with no second init.
    let worker: ExplorerClient | undefined;
    try {
      worker = new ExplorerClient();
      preparedExplorer = worker;
    } catch {
      // Browsers that block workers can still display the restaurant list.
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      worker?.dispose();
    };
    cancelPreparation = cancel;
    const job = loadDataFiles(
      `${import.meta.env.BASE_URL}data/`,
      undefined,
      initialRestaurantId,
      async (bytes: ArrayBuffer, manifest: unknown) => {
        if (cancelled) throw new Error("Restaurant search closed.");
        if (worker) {
          try {
            // Keep the loader's original bytes for exact-snapshot search retries.
            const summary = await worker.prepareSummary({
              bytes: bytes.slice(0),
              manifest,
            });
            if (cancelled) throw new Error("Restaurant search closed.");
            const restaurants = decodeRestaurantColumns(summary.restaurants);
            // Separate row expansion from the loader's indexes and app updates.
            await yieldToBrowser();
            if (cancelled) throw new Error("Restaurant search closed.");
            return {
              ...summary,
              restaurants,
            };
          } catch (error) {
            if (cancelled) throw error;
            worker.dispose();
            if (preparedExplorer === worker) preparedExplorer = undefined;
            // A blocked/crashed worker must not hide usable restaurant data.
            // Local validation still rejects malformed snapshots on this path.
          }
        }
        return decodeSummaryBytes(bytes, manifest);
      },
    )
      .then((snapshot) => {
        if (pending === job) {
          createExplorerData = snapshot.createExplorerData;
          cancelPreparation = undefined;
        }
        return snapshot;
      })
      .catch((error: unknown) => {
        worker?.dispose();
        if (preparedExplorer === worker) preparedExplorer = undefined;
        // Disposal can let a new app begin loading before this old request ends.
        // Its completion must never clear the newer snapshot's state.
        if (pending === job) {
          pending = undefined;
          createExplorerData = undefined;
          cancelPreparation = undefined;
        }
        throw error;
      });
    pending = job;
  }
  return pending.then((snapshot) => snapshot.data);
}

/** Use the same loaded snapshot even if a newer deployment is now available. */
export function getExplorerData() {
  return createExplorerData?.();
}

/** Transfer ownership of the prepared worker to the app, or restart its snapshot. */
export function takeExplorer(restaurants: Restaurant[]) {
  if (preparedExplorer && createExplorerData) {
    const worker = preparedExplorer;
    preparedExplorer = undefined;
    return worker;
  }
  return new ExplorerClient(restaurants, getExplorerData());
}

/** A destroyed app must not leave an unclaimed startup worker running. */
export function disposePreparedExplorer() {
  const cancel = cancelPreparation;
  cancelPreparation = undefined;
  if (cancel) {
    cancel();
    // A new app can start without waiting for a disposed load's network request.
    pending = undefined;
  }
  const worker = preparedExplorer;
  preparedExplorer = undefined;
  worker?.dispose();
}

export async function getInspections(id: string): Promise<Inspection[]> {
  if (!pending) throw new Error("Restaurant summaries are still loading.");
  return (await pending).getInspections(id);
}

/** Intent prefetch is bounded by the same shard/result caches as normal clicks. */
export function prefetchInspections(id: string) {
  void getInspections(id).catch(() => {});
}
