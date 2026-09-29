import type { Finding, Restaurant, Violation } from "./types";

export type ExplorerData = { bytes: ArrayBuffer; manifest: unknown };
type SummaryColumn<T> =
  | T[]
  | { constant: T }
  | { values: T[]; indices: number[] }
  | { ref: keyof Restaurant };
export type SummaryColumns = {
  restaurants: { id: string[] } & {
    [K in Exclude<keyof Restaurant, "id">]: SummaryColumn<Restaurant[K]>;
  };
  definitions: Finding[];
  violations: Violation[];
  cuisines: string[];
  boroughs: string[];
};

export type MapBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};
export type Criteria = {
  search: string;
  borough: string | null;
  cuisine: string | null;
  grade: string | null;
  watchFilter: string | null;
  selected: string[];
};
export type QueryResult = {
  revision: number;
  ids: string[];
  mapped: number;
  unmapped: number;
  bounds: MapBounds | null;
};
export type MapFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    id: string;
    cluster?: boolean;
    cluster_id: number;
    point_count: number;
  };
};
export type ViewportResult = {
  revision: number;
  ids: string[];
  visibleMapped: number;
  features: MapFeature[];
};
type Job = {
  revision: number;
  criteria: Criteria;
  resolve: (value: QueryResult | null) => void;
  reject: (error: Error) => void;
};

export class ExplorerClient {
  private worker: Worker;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private initializing = false;
  private sequence = 0;
  private stopped: Error | null = null;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private queued: Job | null = null;
  private running = false;

  constructor(restaurants?: Restaurant[], source?: ExplorerData) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => {});
    this.worker = new Worker(new URL("./explorer.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = () =>
      this.dispose(new Error("Restaurant search stopped. Please retry."));
    this.worker.onmessageerror = () =>
      this.dispose(
        new Error("Restaurant search could not respond. Please retry."),
      );
    if (source)
      void this.initialize(
        "init-summary",
        [source.bytes, source.manifest],
        [source.bytes],
      );
    else if (restaurants) void this.initialize("init", [restaurants]);
  }

  /** Prepare search once and return validated columns for the UI to expand. */
  prepareSummary(source: ExplorerData): Promise<SummaryColumns> {
    return this.initialize<SummaryColumns>(
      "init-summary",
      [source.bytes, source.manifest, true],
      [source.bytes],
    );
  }

  private initialize<T>(
    type: string,
    args: unknown[],
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.initializing)
      return Promise.reject(
        new Error("Restaurant search already initialized."),
      );
    this.initializing = true;
    const request = this.request<T>(type, args, transfer);
    void request.then(() => this.resolveReady(), this.rejectReady);
    return request;
  }

  private request<T>(
    type: string,
    args: unknown[],
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, args }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Keep at most one running search and one replaceable latest search. */
  query(revision: number, criteria: Criteria): Promise<QueryResult | null> {
    if (this.stopped) return Promise.reject(this.stopped);
    this.queued?.resolve(null);
    const promise = new Promise<QueryResult | null>((resolve, reject) => {
      this.queued = { revision, criteria, resolve, reject };
    });
    void this.pump();
    return promise;
  }
  private async pump() {
    if (this.running || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.running = true;
    try {
      await this.ready;
      job.resolve(
        await this.request<QueryResult>("query", [job.revision, job.criteria]),
      );
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.running = false;
      void this.pump();
    }
  }
  viewport(revision: number, bounds: MapBounds, zoom: number) {
    return this.request<ViewportResult | null>("viewport", [
      revision,
      bounds,
      zoom,
    ]);
  }
  expand(revision: number, clusterId: number) {
    return this.request<{
      revision: number;
      zoom: number;
      ids: string[];
    } | null>("expand", [revision, clusterId]);
  }
  dispose(error = new Error("Restaurant search closed.")) {
    if (this.stopped) return;
    this.stopped = error;
    this.worker.terminate();
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.queued?.reject(error);
    this.queued = null;
  }
}
