import { describe, expect, test } from "bun:test"

import { queued, startCall, task, transcript, withPast, type Entry } from "../src/gui/entries"
import { FOLLOW_THRESHOLD, atBottom } from "../src/gui/scroll"

const texts = (entries: readonly Entry[]) =>
  entries.map((entry) => (entry.kind === "task" ? `${entry.status}:${entry.text}` : `${entry.kind}:${entry.text}`))

const past: Entry[] = [{ id: "p1", kind: "user", text: "earlier", final: true, past: true }]

describe("desktop transcript", () => {
  test("deltas extend the open line and the final text replaces it", () => {
    let entries: readonly Entry[] = []
    entries = transcript(entries, "assistant", "Hel", false)
    entries = transcript(entries, "assistant", "lo", false)
    expect(texts(entries)).toEqual(["assistant:Hello"])
    entries = transcript(entries, "assistant", " Hello there. ", true)
    expect(texts(entries)).toEqual(["assistant:Hello there."])
    entries = transcript(entries, "assistant", "Next", false)
    expect(texts(entries)).toEqual(["assistant:Hello there.", "assistant:Next"])
  })

  test("roles keep separate open lines", () => {
    let entries: readonly Entry[] = []
    entries = transcript(entries, "user", "fix the", false)
    entries = transcript(entries, "assistant", "Sure", false)
    entries = transcript(entries, "user", " tests", false)
    expect(texts(entries)).toEqual(["user:fix the tests", "assistant:Sure"])
  })

  test("blank text adds nothing", () => {
    const entries: readonly Entry[] = []
    expect(transcript(entries, "user", "  ", true)).toBe(entries)
  })
})

const list = (scrollTop: number) => ({ scrollTop, scrollHeight: 1_000, clientHeight: 300 })

describe("desktop transcript scrolling", () => {
  test("follows new text only while the list is at its end", () => {
    expect(atBottom(list(700))).toBe(true)
    expect(atBottom(list(700 - FOLLOW_THRESHOLD))).toBe(true)
  })

  test("stops following once the user scrolls up, including to the very top", () => {
    expect(atBottom(list(700 - FOLLOW_THRESHOLD - 1))).toBe(false)
    expect(atBottom(list(0))).toBe(false)
  })

  test("a list that does not overflow counts as at its end", () => {
    expect(atBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true)
  })
})

describe("desktop tasks", () => {
  test("updates a task in place and counts the queued ones", () => {
    let entries: readonly Entry[] = []
    entries = task(entries, "t1", "Run tests", "queued")
    entries = task(entries, "t2", "Fix lint", "queued")
    expect(queued(entries)).toBe(2)
    entries = task(entries, "t1", "Run tests", "done", "all green")
    expect(texts(entries)).toEqual(["done:Run tests", "queued:Fix lint"])
    expect(queued(entries)).toBe(1)
  })
})

describe("desktop calls in one window", () => {
  test("a new call keeps the earlier lines and marks where it starts", () => {
    let entries: readonly Entry[] = []
    entries = transcript(entries, "user", "first call", true)
    entries = startCall(entries, "New call · 10:42")
    expect(texts(entries)).toEqual(["user:first call", "divider:New call · 10:42"])
  })

  test("the first call in a window starts empty, with no divider", () => {
    expect(startCall([], "New call · 10:42")).toEqual([])
  })

  test("stored turns are shown only before the window has its own transcript", () => {
    expect(texts(withPast([], past, true))).toEqual(["user:earlier"])
    const shown = transcript([], "user", "first call", true)
    expect(texts(withPast(shown, past, false))).toEqual(["user:first call"])
  })
})
