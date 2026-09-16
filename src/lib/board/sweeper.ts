import "server-only";
import { sweepDueCards } from "./mutations";
import { emitBoardForProject } from "./access";

const SWEEP_INTERVAL_MS = 60_000;

async function tick(): Promise<void> {
  try {
    const changedProjectIds = await sweepDueCards();
    if (changedProjectIds.length > 0) {
      await Promise.all(changedProjectIds.map((pid) => emitBoardForProject(pid)));
      console.log(`[sweeper] moved cards to FAILED in ${changedProjectIds.length} project(s)`);
    }
  } catch (err) {
    console.error("[sweeper] tick failed:", err);
  }
}

// `globalThis` survives Next dev's HMR module reloads, so we don't stack up
// duplicate intervals every time this module is re-evaluated.
const globalForSweeper = globalThis as unknown as {
  __overboardSweeper?: NodeJS.Timeout;
};

export function startSweeper(): void {
  if (globalForSweeper.__overboardSweeper) return;
  console.log(`[sweeper] starting, interval ${SWEEP_INTERVAL_MS}ms`);
  const interval = setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
  interval.unref();
  globalForSweeper.__overboardSweeper = interval;
}
