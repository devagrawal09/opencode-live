import { describe, expect, test } from "bun:test"

import { queued, task, transcript, type Entry } from "../src/gui/entries"

const texts = (entries: readonly Entry[]) =>
  entries.map((entry) => (entry.kind === "task" ? `${entry.status}:${entry.text}` : `${entry.kind}:${entry.text}`))

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
