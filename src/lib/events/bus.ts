import "server-only";

// In-process pub/sub for board mutation events. Single source: the same Node process
// receives the mutation (server action or MCP route) and fans it out to any SSE
// connections for that user. Multi-replica deploys would need a real broker — see
// the SSE plan in /home/notyou/.claude/plans/dapper-whistling-parnas.md.

export type BoardEvent = {
  type: "board" | "ideas";
  at: string; // ISO timestamp; mainly useful for client-side debouncing
};

export type Listener = (event: BoardEvent) => void;

// `globalThis` keeps the Map alive across the Next dev server's HMR reloads.
const globalForBus = globalThis as unknown as {
  __overboardBus?: Map<string, Set<Listener>>;
};

function bus(): Map<string, Set<Listener>> {
  if (!globalForBus.__overboardBus) {
    globalForBus.__overboardBus = new Map();
  }
  return globalForBus.__overboardBus;
}

export function subscribe(userId: string, listener: Listener): () => void {
  const b = bus();
  let set = b.get(userId);
  if (!set) {
    set = new Set();
    b.set(userId, set);
  }
  set.add(listener);
  return () => {
    const cur = b.get(userId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) b.delete(userId);
  };
}

export function publish(userId: string, event: BoardEvent): void {
  const set = bus().get(userId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch (err) {
      // One bad listener shouldn't break fan-out for the others.
      console.error("[bus] listener threw:", err);
    }
  }
}

export function subscriberCount(userId: string): number {
  return bus().get(userId)?.size ?? 0;
}
