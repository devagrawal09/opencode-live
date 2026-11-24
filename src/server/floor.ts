/**
 * Who has the floor in a live call, judged from GPT-Live's events. Results the plugin wants spoken wait while the
 * floor is busy, so GPT-Live does not talk over the user. Pure: every method takes the current time.
 *
 * Turn starts (`turn.created`) and output audio are the earliest signals; transcript timing is the fallback when an
 * endpoint does not send them.
 */

/** The user counts as still speaking this long after their last transcript delta. */
export const USER_SPEAKING_MS = 1_200
/** A finished user turn can be a mid-thought pause, so the floor stays theirs this long after it. */
export const USER_PAUSE_MS = 1_200
/** A user turn that started but never finished counts as over this long after its last sign of speech. */
export const USER_TURN_STALE_MS = 5_000
/** A GPT-Live reply that never gets a final transcript counts as over this long after its last delta. */
export const ASSISTANT_STALE_MS = 15_000
/** GPT-Live counts as speaking this long after its last output-audio chunk, even after its reply finished. */
export const ASSISTANT_AUDIO_TAIL_MS = 1_000

export type FloorHolder = "user-speaking" | "user-pause" | "assistant-speaking"

export class Floor {
  private userDeltaAt = -Infinity
  private userFinalAt = -Infinity
  /** Last sign of speech in a user turn that has started and not finished; undefined when none is open. */
  private userTurnAt: number | undefined
  /** Last sign of the GPT-Live reply in progress; undefined when no reply is open. */
  private assistantAt: number | undefined
  private audioAt = -Infinity

  /** A turn started (`turn.created`), before any transcript of it. */
  onTurnStarted(role: "user" | "assistant", now: number) {
    if (role === "user") this.userTurnAt = now
    else this.assistantAt = now
  }

  onTranscript(role: "user" | "assistant", final: boolean, now: number) {
    if (role === "assistant") {
      this.assistantAt = final ? undefined : now
      return
    }
    if (final) {
      this.userFinalAt = now
      this.userTurnAt = undefined
      return
    }
    this.userDeltaAt = now
    if (this.userTurnAt !== undefined) this.userTurnAt = now
  }

  /** Progress on a started turn (`turn.delta`). It keeps an open reply going but never reopens a finished one. */
  onTurnActivity(role: "user" | "assistant", now: number) {
    if (role === "user") this.onTranscript("user", false, now)
    else if (this.assistantAt !== undefined) this.assistantAt = now
  }

  /** GPT-Live sent a chunk of spoken audio. */
  onOutputAudio(now: number) {
    this.audioAt = now
  }

  /** Why the floor is busy at `now`, or undefined when it is free. */
  holder(now: number): FloorHolder | undefined {
    if (now < this.userDeltaAt + USER_SPEAKING_MS) return "user-speaking"
    if (this.userTurnAt !== undefined && now < this.userTurnAt + USER_TURN_STALE_MS) return "user-speaking"
    if (now < this.userFinalAt + USER_PAUSE_MS) return "user-pause"
    if (this.assistantAt !== undefined && now < this.assistantAt + ASSISTANT_STALE_MS) return "assistant-speaking"
    if (now < this.audioAt + ASSISTANT_AUDIO_TAIL_MS) return "assistant-speaking"
    return undefined
  }

  busy(now: number) {
    return this.holder(now) !== undefined
  }

  /**
   * When the floor frees if nothing more is heard (`now` when it is already free). Open turns usually end sooner,
   * with their final transcript, so callers check again on every event.
   */
  freeAt(now: number) {
    return Math.max(
      now,
      this.userDeltaAt + USER_SPEAKING_MS,
      this.userTurnAt === undefined ? -Infinity : this.userTurnAt + USER_TURN_STALE_MS,
      this.userFinalAt + USER_PAUSE_MS,
      this.assistantAt === undefined ? -Infinity : this.assistantAt + ASSISTANT_STALE_MS,
      this.audioAt + ASSISTANT_AUDIO_TAIL_MS,
    )
  }
}
