import { describe, expect, test } from "bun:test"

import {
  ASSISTANT_AUDIO_TAIL_MS,
  ASSISTANT_STALE_MS,
  Floor,
  USER_PAUSE_MS,
  USER_SPEAKING_MS,
  USER_TURN_STALE_MS,
} from "../src/server/floor"

describe("floor", () => {
  test("is free before anyone talks", () => {
    const floor = new Floor()
    expect(floor.busy(1_000)).toBe(false)
    expect(floor.freeAt(1_000)).toBe(1_000)
  })

  test("a user transcript delta holds it briefly", () => {
    const floor = new Floor()
    floor.onTranscript("user", false, 1_000)
    expect(floor.holder(1_000 + USER_SPEAKING_MS - 1)).toBe("user-speaking")
    expect(floor.freeAt(1_000)).toBe(1_000 + USER_SPEAKING_MS)
    expect(floor.busy(1_000 + USER_SPEAKING_MS)).toBe(false)
  })

  test("a finished user turn is followed by a pause that is still theirs", () => {
    const floor = new Floor()
    floor.onTranscript("user", true, 1_000)
    expect(floor.holder(1_000 + USER_PAUSE_MS - 1)).toBe("user-pause")
    expect(floor.busy(1_000 + USER_PAUSE_MS)).toBe(false)
  })

  test("a started user turn holds it until it finishes, or goes stale", () => {
    const floor = new Floor()
    floor.onTurnStarted("user", 0)
    floor.onTurnActivity("user", 3_000)
    expect(floor.holder(3_000 + USER_TURN_STALE_MS - 1)).toBe("user-speaking")
    expect(floor.busy(3_000 + USER_TURN_STALE_MS)).toBe(false)

    floor.onTurnStarted("user", 10_000)
    floor.onTranscript("user", true, 11_000)
    expect(floor.holder(11_000 + USER_PAUSE_MS - 1)).toBe("user-pause")
    expect(floor.busy(11_000 + USER_PAUSE_MS)).toBe(false)
  })

  test("GPT-Live mid-reply holds it until the reply finishes, capped", () => {
    const floor = new Floor()
    floor.onTranscript("assistant", false, 1_000)
    expect(floor.holder(5_000)).toBe("assistant-speaking")
    floor.onTranscript("assistant", true, 5_000)
    expect(floor.busy(5_000)).toBe(false)

    floor.onTurnStarted("assistant", 10_000)
    expect(floor.freeAt(10_000)).toBe(10_000 + ASSISTANT_STALE_MS)
    expect(floor.busy(10_000 + ASSISTANT_STALE_MS)).toBe(false)
  })

  test("turn progress never reopens a finished reply", () => {
    const floor = new Floor()
    floor.onTurnActivity("assistant", 1_000)
    expect(floor.busy(1_000)).toBe(false)
  })

  test("output audio holds it for a short tail", () => {
    const floor = new Floor()
    floor.onOutputAudio(1_000)
    expect(floor.holder(1_000 + ASSISTANT_AUDIO_TAIL_MS - 1)).toBe("assistant-speaking")
    expect(floor.busy(1_000 + ASSISTANT_AUDIO_TAIL_MS)).toBe(false)
  })

  test("frees at the latest of everything still holding it", () => {
    const floor = new Floor()
    floor.onTranscript("user", false, 1_000)
    floor.onTranscript("user", true, 1_500)
    expect(floor.freeAt(1_500)).toBe(1_500 + USER_PAUSE_MS)
  })
})
