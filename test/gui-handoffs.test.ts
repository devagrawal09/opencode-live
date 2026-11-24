import { describe, expect, test } from "bun:test"

import { HANDOFFS_KEPT, applyStep, phaseOf, timingLine, toolDuration, totalOf, type Handoff } from "../src/gui/handoffs"
import type { HandoffStep } from "../src/shared/rpc"

const T = 1_000_000

function run(...steps: [string, number, HandoffStep][]) {
  let list: Handoff[] = []
  for (const [delegationID, at, step] of steps) list = applyStep(list, { delegationID, at, step })
  return list
}

const received = (request: string): HandoffStep => ({
  kind: "received",
  request,
  context: { turns: 2, updates: 1, chars: 340, first: true },
})

describe("voice-agent hand-offs", () => {
  test("builds one hand-off from its steps, with times and the reply", () => {
    const [handoff] = run(
      ["del_a", T, received("What is the build status?")],
      ["del_a", T + 50, { kind: "queued" }],
      ["del_a", T + 200, { kind: "delivered" }],
      ["del_a", T + 300, { kind: "started" }],
      ["del_a", T + 1_100, { kind: "first-token" }],
      ["del_a", T + 3_100, { kind: "replied", channel: "commentary", text: "Sent it.", outcome: "succeeded" }],
      ["del_a", T + 3_600, { kind: "spoken" }],
    )
    expect(handoff.request).toBe("What is the build status?")
    expect(handoff.context).toEqual({ turns: 2, updates: 1, chars: 340, first: true })
    expect(handoff.reply).toEqual({ channel: "commentary", text: "Sent it." })
    expect(phaseOf(handoff)).toBe("succeeded")
    expect(totalOf(handoff)).toBe(3_100)
    expect(
      timingLine(
        handoff,
        (key) => (key === "firstToken" ? "1st token" : key === "replied" ? "reply" : key),
        (channel) => channel,
      ),
    ).toBe(
      "queued +0.1s · delivered +0.2s · started +0.3s · 1st token +1.1s · reply +3.1s (commentary) · spoken ~+3.6s",
    )
  })

  test("updates a tool call in place and times it", () => {
    const [handoff] = run(
      ["del_a", T, received("Run the tests")],
      [
        "del_a",
        T + 100,
        { kind: "tool", id: "call_1", name: "gptlive_main_send", status: "running", args: '{"text":"x"}' },
      ],
      ["del_a", T + 400, { kind: "tool", id: "call_1", name: "gptlive_main_send", status: "done", result: "Queued." }],
      ["del_a", T + 500, { kind: "tool", id: "call_2", name: "gptlive_main_read", status: "running" }],
    )
    expect(handoff.tools).toEqual([
      {
        id: "call_1",
        name: "gptlive_main_send",
        status: "done",
        args: '{"text":"x"}',
        result: "Queued.",
        startedAt: T + 100,
        endedAt: T + 400,
      },
      { id: "call_2", name: "gptlive_main_read", status: "running", startedAt: T + 500 },
    ])
    expect(toolDuration(handoff.tools[0])).toBe(300)
    expect(toolDuration(handoff.tools[1])).toBeUndefined()
    expect(phaseOf(handoff)).toBe("waiting")
  })

  test("keeps hand-offs apart, the first time of each step, and tokens and cost", () => {
    const list = run(
      ["del_a", T, received("First")],
      ["del_b", T + 10, received("Second")],
      ["del_a", T + 20, { kind: "started" }],
      ["del_a", T + 30, { kind: "started" }],
      [
        "del_a",
        T + 40,
        { kind: "replied", channel: "none", outcome: "failed", tokens: { input: 10, output: 2 }, cost: 0.001 },
      ],
    )
    expect(list.map((item) => item.id)).toEqual(["del_a", "del_b"])
    expect(list[0].times.started).toBe(T + 20)
    expect(list[0]).toMatchObject({ outcome: "failed", tokens: { input: 10, output: 2 }, cost: 0.001 })
    expect(list[0].reply).toEqual({ channel: "none" })
    expect(phaseOf(list[1])).toBe("waiting")
  })

  test("a step for an unknown hand-off starts it, and only the newest are kept", () => {
    const [orphan] = run(["del_x", T, { kind: "delivered" }])
    expect(orphan.request).toBeUndefined()
    expect(phaseOf(orphan)).toBe("running")
    expect(
      timingLine(
        orphan,
        (key) => key,
        (channel) => channel,
      ),
    ).toBe("delivered +0.0s")

    let list: Handoff[] = []
    for (let i = 0; i < HANDOFFS_KEPT + 5; i++)
      list = applyStep(list, { delegationID: `del_${i}`, at: T + i, step: received(`r${i}`) })
    expect(list).toHaveLength(HANDOFFS_KEPT)
    expect(list[0].id).toBe("del_5")
  })
})
