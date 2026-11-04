/**
 * Per-Session state for the Pi-style observe/retro reminder.
 *
 * The engine keeps a single mutable ReminderState for one process. DSH can
 * host several Sessions in one process, so the same state must be keyed by
 * Session id and dropped on disposal. This tiny module is shared by the
 * ambient hook (which counts user turns) and the wiki_observe tool (which
 * marks the Session as satisfied).
 */

export interface SessionReminderState {
  /** True after wiki_observe has run in this Session. */
  observeDone: boolean;
  /** Number of user turns since the last reminder (or Session start). */
  turns: number;
}

export type ReminderStates = Map<string, SessionReminderState>;

export function sessionKeyOf(agent: unknown): string | undefined {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" ? id : undefined;
}

export function reminderStateFor(
  states: ReminderStates | undefined,
  agent: unknown,
): SessionReminderState | undefined {
  const key = sessionKeyOf(agent);
  return key ? states?.get(key) : undefined;
}

export function markObserved(states: ReminderStates | undefined, agent: unknown): void {
  const state = reminderStateFor(states, agent);
  if (state) state.observeDone = true;
}
