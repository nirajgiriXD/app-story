import { dataDirFor, serialQueue, type SerialQueue } from "@app-story/shared";
import { Store } from "./store/store";

/**
 * What jobs in one process share: the lane their heavy phases take turns in, and the open
 * database connections. The CLI uses the default one; a test or a long-running host can
 * make its own, so its jobs neither wait behind nor write into anyone else's, and
 * `close()` lets go of what it holds. (The voice and word-timing models stay loaded once
 * per process: loading them takes seconds and hundreds of MB.)
 */
export class Runtime {
  /**
   * When several videos are made at once, their CPU-heavy or timing-sensitive phases (speech,
   * recording, rendering) take turns here. A recording that competes for the CPU drops frames,
   * and two renders at once are no faster than one after the other. AI planning, which mostly
   * waits on the network, still overlaps freely.
   */
  readonly heavy: SerialQueue = serialQueue();
  private readonly stores = new Map<string, Store>();

  /** The database in a data folder; one connection per folder. */
  store(dataDir: string): Store {
    let store = this.stores.get(dataDir);
    if (!store) {
      store = new Store(dataDir);
      this.stores.set(dataDir, store);
    }
    return store;
  }

  /** Close every database connection. The runtime can still be used: stores reopen on demand. */
  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}

let shared: Runtime | undefined;

/** The process's runtime, used when a request does not bring its own. */
export function defaultRuntime(): Runtime {
  shared ??= new Runtime();
  return shared;
}

/** The database that belongs to an output folder (`<parent>/.app-story/app-story.db`). */
export function storeFor(outputDir: string, runtime: Runtime = defaultRuntime()): Store {
  return runtime.store(dataDirFor(outputDir));
}
