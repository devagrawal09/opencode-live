import { describe, expect, test } from "bun:test"

import { countsOf, describeEvent, noisy } from "../src/gui/events"

describe("debug event view", () => {
  test("summarizes turns with role, id, timing and clipped text", () => {
    expect(
      describeEvent({
        type: "turn.delta",
        turn_id: "t1",
        start_ms: 100,
        end_ms: 400,
        delta: "  hello   there ",
      }),
    ).toBe("turn=t1 · ms=100–400 · text=hello there")
    expect(describeEvent({ type: "turn.created", turn: { id: "t2", role: "user" } })).toBe("role=user · turn=t2")
  })

  test("summarizes delegations and errors", () => {
    expect(
      describeEvent({ type: "delegation.created", item: { type: "delegation", target: "client" }, offset_ms: 12 }),
    ).toBe("item=delegation · target=client · offset=12")
    expect(describeEvent({ type: "error", error: { message: "expired" } })).toBe("error=expired")
  })

  test("clips long text and leaves audio out of the list", () => {
    expect(describeEvent({ type: "x", delta: "a".repeat(100) })).toBe(`text=${"a".repeat(59)}…`)
    expect(noisy("session.output_audio.delta")).toBe(true)
    expect(noisy("session.input_audio.append")).toBe(true)
    expect(noisy("turn.delta")).toBe(false)
  })

  test("counts are listed most frequent first", () => {
    expect(
      countsOf(
        new Map([
          ["a", 1],
          ["b", 5],
          ["c", 5],
        ]),
      ),
    ).toEqual([
      ["b", 5],
      ["c", 5],
      ["a", 1],
    ])
  })
})
