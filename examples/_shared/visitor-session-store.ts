import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PersistedVisitorSession {
  roomToken: string;
  symKeyHex: string;
  widgetId: string;
  visitorLabel: string;
  origin: string;
}

// Plain JSON file, read-modify-write on every change — fine for an example
// bot's traffic, not a pattern to scale to a high-volume production one.
// Mirrors the webapp's IndexedDB-backed visitor-session persistence (see
// db.ts's visitorSessions table / EvergramProvider's boot-time
// rehydration) — the SDK has no equivalent of its own, since these rooms
// are in-memory-only state the gateway never persists either (see
// CreateVisitorRoom's doc comment), so without writing this down
// yourself a process restart loses every active visitor conversation. See
// EvergramCore.registerVisitorSession's doc comment for how this gets fed
// back in on the next run.
export function loadPersistedVisitorSessions(path: string): PersistedVisitorSession[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

export function savePersistedVisitorSession(path: string, session: PersistedVisitorSession): void {
  const sessions = loadPersistedVisitorSessions(path).filter(
    (s) => s.roomToken !== session.roomToken,
  );
  sessions.push(session);
  writeFileSync(path, JSON.stringify(sessions, null, 2));
}

export function removePersistedVisitorSession(path: string, roomToken: string): void {
  const sessions = loadPersistedVisitorSessions(path).filter((s) => s.roomToken !== roomToken);
  writeFileSync(path, JSON.stringify(sessions, null, 2));
}
