import { describe, expect, test } from "bun:test"

import { claims } from "../src/server/auth"
import { toolLabel } from "../src/server/bridge"
import { background, filler, historyFrom, initialItems, speakable } from "../src/server/context"
import { chunk, contextAppend, parseCallID, parseEvent } from "../src/server/live"

describe("call id", () => {
  test("reads the rtc id from the Location header", () => {
    expect(parseCallID("/v1/realtime/calls/rtc_u24_ABC-def", null)).toBe("rtc_u24_ABC-def")
  })
  test("falls back to openai-session-id", () => {
    expect(parseCallID(null, "rtc_fallback")).toBe("rtc_fallback")
  })
  test("rejects responses without an id", () => {
    expect(() => parseCallID("/v1/other", "nope")).toThrow()
  })
})

describe("events", () => {
  test("delegation carries the task text", () => {
    const event = parseEvent(
      JSON.stringify({
        type: "delegation.created",
        item: {
          id: "item_1",
          type: "delegation",
          target: "client",
          content: [
            { type: "input_text", text: "How many " },
            { type: "input_text", text: "files?" },
          ],
        },
      }),
    )
    expect(event).toEqual({ kind: "delegation", id: "item_1", text: "How many files?" })
  })
  test("transcripts and turns", () => {
    expect(parseEvent(JSON.stringify({ type: "output_transcript.added", item: { text: " hi" } }))).toEqual({
      kind: "transcript",
      role: "assistant",
      text: " hi",
      final: false,
    })
    expect(parseEvent(JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "hello" } }))).toEqual({
      kind: "transcript",
      role: "user",
      text: "hello",
      final: true,
    })
  })
  test("auth errors are fatal", () => {
    const event = parseEvent(JSON.stringify({ type: "error", error: { code: "token_expired", message: "expired" } }))
    expect(event).toEqual({ kind: "error", message: "expired", fatal: true })
  })
  test("unknown events keep their type and field names", () => {
    expect(parseEvent(JSON.stringify({ type: "input_speech.started", item_id: "x", at: 1 }))).toEqual({
      kind: "other",
      type: "input_speech.started",
      keys: ["item_id", "at"],
    })
  })
  test("turn starts, turn progress and output audio are floor signals", () => {
    expect(parseEvent(JSON.stringify({ type: "turn.created", turn: { id: "turn_1", role: "user" } }))).toEqual({
      kind: "turn",
      role: "user",
      id: "turn_1",
    })
    expect(parseEvent(JSON.stringify({ type: "turn.created", turn: { role: "assistant" } }))).toEqual({
      kind: "turn",
      role: "assistant",
    })
    expect(parseEvent(JSON.stringify({ type: "turn.created", turn: { id: "turn_2" } }))).toEqual({
      kind: "other",
      type: "turn.created",
      keys: ["turn"],
    })
    expect(
      parseEvent(JSON.stringify({ type: "turn.delta", turn_id: "turn_1", delta: "hi", start_ms: 0, end_ms: 200 })),
    ).toEqual({ kind: "turn-delta", id: "turn_1" })
    expect(parseEvent(JSON.stringify({ type: "session.output_audio.delta", delta: "AAAA" }))).toEqual({
      kind: "output-audio",
    })
  })
  test("ignores garbage", () => {
    expect(parseEvent("not json")).toBeUndefined()
    expect(parseEvent(JSON.stringify({ nope: 1 }))).toBeUndefined()
  })
})

describe("context appends", () => {
  test("chunks by UTF-8 bytes without splitting characters", () => {
    const text = "é".repeat(400)
    const parts = chunk(text, 500)
    expect(parts.join("")).toBe(text)
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(500)
  })
  test("delegation vs session context", () => {
    expect(contextAppend("done", "speakable", "item_1")[0]).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "item_1",
      channel: "speakable",
      content: [{ type: "input_text", text: "done" }],
    })
    expect(contextAppend("note", "commentary")[0].type).toBe("session.context.append")
  })
})

describe("instructions", () => {
  test("history is quoted and bounded", () => {
    const history = historyFrom([
      { type: "user", text: "fix the <build>" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "Done." },
          { type: "tool", name: "edit" },
        ],
      },
      { type: "synthetic", text: "ignored" },
    ])
    expect(history).toEqual([
      { role: "user", text: "fix the <build>" },
      { role: "assistant", text: "Done." },
    ])
    const block = background(history)
    expect(block).toContain("<session_history>")
    expect(block).not.toContain("<build>")
  })
  test("speakable strips code", () => {
    expect(speakable("Here:\n```ts\nconst x = 1\n```\nUse `foo`.")).toBe("Here:\n [code omitted] \nUse foo.")
  })
  test("tool labels", () => {
    expect(toolLabel("edit")).toBe("editing code")
    expect(toolLabel("gptlive_main_send")).toBe("handing work to OpenCode")
    expect(toolLabel("mcp_custom_thing")).toBe("using mcp custom thing")
  })
})

describe("auth claims", () => {
  test("reads account and plan from the access token", () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc", chatgpt_plan_type: "pro" } }),
    ).toString("base64url")
    expect(claims(`h.${payload}.s`)).toEqual({ chatgpt_account_id: "acc", chatgpt_plan_type: "pro" })
    expect(claims("garbage")).toEqual({})
  })
})

const text = (item: { content: [{ text: string }] }) => item.content[0].text

describe("call initial items", () => {
  const history = [
    { role: "user" as const, text: "fix the transcript scrolling" },
    { role: "assistant" as const, text: "Fixed it in window.tsx." },
  ]
  const previous = [
    { role: "user" as const, text: "summarize the plugin changes" },
    { role: "assistant" as const, text: "Six local commits." },
  ]
  test("earlier voice turns become real messages, then a developer note closes the list", () => {
    const items = initialItems({ project: "demo", title: "Voice plugin", previous, history })
    expect(items.map((item) => [item.role, item.content[0].type])).toEqual([
      ["user", "input_text"],
      ["assistant", "output_text"],
      ["developer", "input_text"],
    ])
    expect(text(items[0])).toBe("summarize the plugin changes")
    const note = text(items[2])
    expect(note).toContain("earlier voice calls")
    expect(note).toContain('OpenCode coding session "Voice plugin" in the project "demo", not this voice call')
    expect(note).toContain("Answer recap questions about it")
    expect(note).toContain("<session_history>")
    expect(note).toContain("Fixed it in window.tsx.")
  })

  test("a first call starts with only the developer note", () => {
    const items = initialItems({ project: "demo", previous: [], history: [] })
    expect(items).toHaveLength(1)
    expect(items[0].role).toBe("developer")
    expect(text(items[0])).not.toContain("earlier voice calls")
    expect(text(items[0])).not.toContain("<session_history>")
  })

  test("keeps only the latest earlier turns", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, text: `turn ${index}` }))
    const items = initialItems({ project: "demo", previous: many, history: [] })
    expect(items).toHaveLength(21)
    expect(text(items[0])).toBe("turn 10")
  })
})

describe("filler turns", () => {
  test("backchannel-only turns are filler, with sound tags closed or cut off", () => {
    expect(filler("Mm-hmm. Right. Yeah. Mm-hmm. Mm-hmm.")).toBe(true)
    expect(filler("Mm-hmm. [lip Mm-hmm. [lip smack Right. Yeah. Mm-hmm.")).toBe(true)
    expect(filler("[laughs] Okay.")).toBe(true)
  })

  test("anything with content is kept", () => {
    expect(filler("Right, run the tests.")).toBe(false)
    expect(filler("[laughs Sure, here is the plan")).toBe(false)
    expect(filler("")).toBe(false)
  })

  test("earlier filler turns are left out of a call's initial items", () => {
    const previous = [
      { role: "assistant" as const, text: "Mm-hmm. Right. Yeah." },
      { role: "user" as const, text: "what did we change" },
    ]
    const items = initialItems({ project: "demo", previous, history: [] })
    expect(items.map((item) => item.content[0].text).slice(0, -1)).toEqual(["what did we change"])
  })
})
