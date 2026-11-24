/** How long a call started by the wake word may stay quiet before it hangs up. */
export const IDLE_AFTER = 20_000
/** Speaker level (the meter's 0 to 1 scale) under which GPT-Live counts as silent. */
export const SPEAKER_QUIET = 0.1

export interface Busy {
  /** GPT-Live's current speaker level. */
  speaker: number
  /** Tasks waiting in the coding session. */
  queued: number
  /** The voice agent or the coding session is working. */
  working: boolean
}

/**
 * When a call started by the wake word has gone quiet: no transcript, GPT-Live silent, no queued tasks and nothing
 * working, for `after` milliseconds. Transcripts and hand-off steps `touch` it; `expired` also counts what is still
 * going on as activity.
 */
export class IdleClock {
  private last: number

  constructor(
    readonly after = IDLE_AFTER,
    now = Date.now(),
  ) {
    this.last = now
  }

  touch(now: number) {
    this.last = Math.max(this.last, now)
  }

  expired(busy: Busy, now: number): boolean {
    if (busy.speaker > SPEAKER_QUIET || busy.queued > 0 || busy.working) this.touch(now)
    return now - this.last >= this.after
  }
}
