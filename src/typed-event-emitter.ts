import { EventEmitter } from "node:events";

// Thin typed wrapper over Node's EventEmitter — same on/off/emit surface,
// just with each event name tied to its payload tuple so `core.on("mesage",
// ...)` (typo) or `core.emit("connected", 123)` (wrong payload) fail at
// compile time instead of silently doing nothing / passing garbage through.
// No new dependency: this is the whole implementation, not a library import.
//
// TEvents is intentionally unconstrained (not `extends Record<string,
// unknown[]>`) — a plain `interface` like EvergramCoreEvents has no index
// signature and TS would reject it against that constraint, forcing callers
// to either add one (defeating the typo-checking this exists for) or switch
// to `type`. Indexing TEvents[K] per-key below is all that's actually needed.
export class TypedEventEmitter<TEvents> extends EventEmitter {
  on<K extends keyof TEvents & string>(event: K, listener: (...args: TEvents[K] & unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof TEvents & string>(event: K, listener: (...args: TEvents[K] & unknown[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof TEvents & string>(event: K, listener: (...args: TEvents[K] & unknown[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K] & unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
