// Shutdown waits for the writes in flight. An order, close, bracket or cancel holds its market from
// before its broadcast until its journal row is written, and the stdio lifecycle ends a session by
// closing stdin (then signals): exiting at once there could land a transaction with no journal row,
// which the daily cap and the receipts would never see. So exit only when no market is held, or
// after `limitMs` (an SDK send is itself bounded well inside that).
export const onShutdown = ({ busy, exit = (c) => process.exit(c), limitMs = 30_000, pollMs = 100, now = Date.now, wait = setTimeout }) => {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const until = now() + limitMs;
    const tick = () => (!busy() || now() >= until ? exit(0) : wait(tick, pollMs));
    tick();
  };
};
