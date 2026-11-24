import { describe, expect, jest, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { Bridge, type BridgeEvents } from "../src/server/bridge"
import type { Sideband } from "../src/server/live"
import type { HandoffStep } from "../src/shared/rpc"

const prompts = path.join(import.meta.dir, "../src/server/prompts")

describe("capability wording", () => {
  test("screen questions are not treated as project work", () => {
    const voice = readFileSync(path.join(prompts, "gpt-live/03-thinking-and-acting.md"), "utf8")
    const boundaries = readFileSync(path.join(prompts, "voice-agent/04-boundaries.md"), "utf8")
    expect(voice).toContain('questions like "can you see my screen?" need no delegation')
    expect(boundaries).toContain('never turn a temporary failure into "I cannot access the project."')
  })

  test("results wait for the user instead of talking over them", () => {
    const context = readFileSync(path.join(prompts, "gpt-live/05-context.md"), "utf8")
    const listening = readFileSync(path.join(prompts, "gpt-live/04-listening.md"), "utf8")
    expect(context).toContain("say at your next turn")
    expect(context).toContain("Never talk over the user for it")
    expect(listening).toContain("Interruption policy:")
    expect(listening).toContain("Backchannel policy:")
  })
})

class FakeSideband {
  readonly spoken: string[] = []
  readonly appends: { text: string; channel: "speakable" | "commentary"; delegationID?: string }[] = []
  append(text: string, channel: "speakable" | "commentary", delegationID?: string) {
    if (channel === "speakable") this.spoken.push(text)
    this.appends.push({ text, channel, ...(delegationID ? { delegationID } : {}) })
  }
  close() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type SessionEvent = { type: string; created?: number; data: Record<string, unknown> }

class EventStream {
  private queued: SessionEvent[] = []
  private readers: Array<(value: SessionEvent | null) => void> = []
  private ended = false

  emit(event: SessionEvent) {
    if (this.ended) return
    const reader = this.readers.shift()
    if (reader) reader(event)
    else this.queued.push(event)
  }

  end() {
    if (this.ended) return
    this.ended = true
    for (const reader of this.readers.splice(0)) reader(null)
  }

  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const queued = this.queued.shift()
      if (queued) {
        yield queued
        continue
      }
      // The queue has to wait for the next event; this is not a parallelizable loop.
      // oxlint-disable-next-line no-await-in-loop
      const next = await new Promise<SessionEvent | null>((resolve) => this.readers.push(resolve))
      if (next === null) return
      yield next
    }
  }
}

function harness() {
  const statuses: string[] = []
  const sideband = new FakeSideband()
  const stream = new EventStream()
  const pendingPrompts: Array<ReturnType<typeof deferred<{ id: string }>>> = []
  const lines: Record<string, unknown>[] = []
  const log = { write: (entry: Record<string, unknown>) => lines.push(entry) }
  const steps: { delegationID: string; at: number; step: HandoffStep }[] = []
  let ended = ""
  const events = {
    handoff: (delegationID: string, at: number, step: HandoffStep) => steps.push({ delegationID, at, step }),
    task: (id: string, _text: string, status: string) => statuses.push(`${id}:${status}`),
    activity: () => {},
    transcript: () => {},
    closed: () => {},
    error: () => {},
    end: (reason: string) => {
      ended = reason
    },
  }
  const ctx = {
    session: {
      prompt: () => {
        const pending = deferred<{ id: string }>()
        pendingPrompts.push(pending)
        return pending.promise
      },
    },
    event: {
      subscribe: () => stream,
    },
  }
  const bridge = new Bridge(
    ctx as never,
    "main",
    "voice",
    sideband as unknown as Sideband,
    events as unknown as BridgeEvents,
    log as never,
  )
  return {
    bridge,
    sideband,
    statuses,
    stream,
    lines,
    steps,
    ended: () => ended,
    prompt: () => pendingPrompts.at(-1)!,
  }
}

async function settle() {
  await Bun.sleep(0)
}

/** Lets queued promise callbacks run without relying on timers, which may be faked. */
async function flush() {
  for (let turn = 0; turn < 10; turn++) {
    // Each turn drains one round of promise callbacks; the rounds are sequential by design.
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe("delegated task outcomes", () => {
  test("a rejected prompt is spoken once and emits a failed status", async () => {
    const { bridge, sideband, statuses, prompt } = harness()
    const result = bridge.send("Inspect the project")
    prompt().reject(new Error("Model access is disabled"))

    await expect(result).resolves.toContain("Failed before the coding session started")
    expect(statuses).toEqual(["task_1:queued", "task_1:failed"])
    expect(sideband.spoken).toEqual([
      'The task "Inspect the project" failed before it started: Model access is disabled',
    ])
    bridge.close()
  })

  test("a queued task keeps its own result when earlier work finishes", async () => {
    const { bridge, sideband, statuses, stream, prompt } = harness()
    const first = bridge.send("Task A")
    prompt().resolve({ id: "inbox_a" })
    await first
    stream.emit({ type: "session.inbox.delivered", data: { sessionID: "main", inboxID: "inbox_a" } })
    stream.emit({ type: "session.execution.started", data: { sessionID: "main" } })
    await settle()

    const second = bridge.send("Task B")
    prompt().resolve({ id: "inbox_b" })
    await second
    stream.emit({ type: "session.text.ended", data: { sessionID: "main", text: "A is done" } })
    stream.emit({ type: "session.execution.succeeded", data: { sessionID: "main" } })
    await settle()

    expect(sideband.spoken).toEqual(['Finished the task "Task A". Outcome: A is done'])
    expect(statuses).toContain("task_2:queued")
    expect(statuses).not.toContain("task_2:done")

    stream.emit({ type: "session.inbox.delivered", data: { sessionID: "main", inboxID: "inbox_b" } })
    stream.emit({ type: "session.text.ended", data: { sessionID: "main", text: "B is done" } })
    stream.emit({ type: "session.execution.succeeded", data: { sessionID: "main" } })
    await settle()

    expect(sideband.spoken).toEqual([
      'Finished the task "Task A". Outcome: A is done',
      'Finished the task "Task B". Outcome: B is done',
    ])
    bridge.close()
  })

  test("an execution failure before inbox delivery is spoken once", async () => {
    const { bridge, sideband, statuses, stream, prompt } = harness()
    const pending = bridge.send("Inspect the project")
    prompt().resolve({ id: "inbox_1" })
    await pending
    stream.emit({ type: "session.execution.started", data: { sessionID: "main" } })
    stream.emit({
      type: "session.execution.failed",
      data: { sessionID: "main", error: { message: "Model access is disabled" } },
    })
    await settle()

    expect(statuses).toEqual(["task_1:queued", "task_1:running", "task_1:failed"])
    expect(sideband.spoken).toEqual(['The task "Inspect the project" failed: Model access is disabled'])
    bridge.close()
  })

  test("a queued task the user removes is not reported with another run's result", async () => {
    const { bridge, sideband, statuses, stream, prompt } = harness()
    const pending = bridge.send("Refactor the parser")
    prompt().resolve({ id: "inbox_1" })
    await pending
    stream.emit({ type: "session.inbox.cancelled", data: { sessionID: "main", inboxID: "inbox_1" } })
    stream.emit({ type: "session.execution.started", data: { sessionID: "main" } })
    stream.emit({ type: "session.text.ended", data: { sessionID: "main", text: "All 57 tests pass" } })
    stream.emit({ type: "session.execution.succeeded", data: { sessionID: "main" } })
    await settle()

    expect(statuses).toEqual(["task_1:queued", "task_1:cancelled"])
    expect(sideband.spoken).toEqual([])
    bridge.close()
  })

  test("a task whose prompt is still pending does not take another run's result", async () => {
    const { bridge, sideband, statuses, stream, prompt } = harness()
    const pending = bridge.send("Inspect the project")
    stream.emit({ type: "session.execution.started", data: { sessionID: "main" } })
    stream.emit({ type: "session.text.ended", data: { sessionID: "main", text: "Typed work is done" } })
    stream.emit({ type: "session.execution.succeeded", data: { sessionID: "main" } })
    await settle()
    prompt().reject(new Error("Model access is disabled"))
    await pending

    expect(statuses).toEqual(["task_1:queued", "task_1:failed"])
    expect(sideband.spoken).toEqual([
      'The task "Inspect the project" failed before it started: Model access is disabled',
    ])
    bridge.close()
  })

  test("a lost event stream reports open tasks once and ends the call after it is spoken", async () => {
    const { bridge, sideband, statuses, stream, prompt, ended } = harness()
    const pending = bridge.send("Inspect the project")
    prompt().resolve({ id: "inbox_1" })
    await pending
    jest.useFakeTimers()
    try {
      stream.end()
      await flush()

      expect(sideband.spoken).toEqual([
        'Lost track of the task "Inspect the project" when the OpenCode event stream disconnected. Its result is unknown.',
      ])
      expect(statuses).toContain("task_1:failed")
      await expect(bridge.send("Again")).rejects.toThrow("event stream is gone")
      expect(bridge.endCall()).toBe("The call is already ending.")
      expect(ended()).toBe("")
      jest.advanceTimersByTime(4_500)
      expect(ended()).toContain("Lost the OpenCode event stream")
      expect(sideband.spoken).toHaveLength(1)
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("closing the call before the lost-stream hang-up cancels it", async () => {
    const { bridge, stream, ended } = harness()
    jest.useFakeTimers()
    try {
      stream.end()
      await flush()
      bridge.close()
      jest.advanceTimersByTime(4_500)
      expect(ended()).toBe("")
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("event trace", () => {
  test("logs the first few of each unhandled event type, then counts them at close", () => {
    const lines: Record<string, unknown>[] = []
    const log = { write: (entry: Record<string, unknown>) => lines.push(entry) }
    const sideband = new FakeSideband()
    const ctx = { session: { prompt: async () => ({}) }, event: { subscribe: () => (async function* () {})() } }
    const bridge = new Bridge(
      ctx as never,
      "main",
      "voice",
      sideband as unknown as Sideband,
      { error: () => {} } as unknown as BridgeEvents,
      log as never,
    )
    for (let i = 0; i < 5; i++) bridge.handle({ kind: "other", type: "input_speech.started", keys: ["item_id"] })
    bridge.trace("window", "output_audio.delta", ["delta"], 40)
    bridge.close()
    expect(lines.filter((line) => line.type === "live-event")).toEqual([
      { type: "live-event", source: "sideband", event: "input_speech.started", keys: ["item_id"] },
      { type: "live-event", source: "sideband", event: "input_speech.started", keys: ["item_id"] },
      { type: "live-event", source: "sideband", event: "input_speech.started", keys: ["item_id"] },
      { type: "live-event", source: "window", event: "output_audio.delta", keys: ["delta"] },
    ])
    expect(lines.at(-1)).toEqual({
      type: "live-events",
      counts: { "sideband:input_speech.started": 5, "window:output_audio.delta": 40 },
    })
  })
})

/** One transcript event: a delta while someone talks, or the end of their turn. */
function heard(bridge: Bridge, role: "user" | "assistant", final = false) {
  bridge.handle({ kind: "transcript", role, text: final ? "done talking" : "talk", final })
}

/** Emits session events one at a time, letting the bridge react to each. */
async function emit(stream: EventStream, ...events: SessionEvent[]) {
  for (const event of events) {
    stream.emit(event)
    // Each event must be handled before the next is emitted; the order is the point.
    // oxlint-disable-next-line no-await-in-loop
    await flush()
  }
}

/** Sends a task that OpenCode rejects, which speaks one failure outcome. */
async function rejected(harnessed: ReturnType<typeof harness>, text: string) {
  const result = harnessed.bridge.send(text)
  harnessed.prompt().reject(new Error("Model access is disabled"))
  await result
}

describe("the floor", () => {
  test("an outcome during user speech is held until they finish and pause, then sent once", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, lines } = harnessed
    try {
      heard(bridge, "user")
      await rejected(harnessed, "Task A")
      expect(sideband.appends).toEqual([])
      jest.advanceTimersByTime(1_000)
      heard(bridge, "user")
      jest.advanceTimersByTime(500)
      heard(bridge, "user", true)
      jest.advanceTimersByTime(1_100)
      expect(sideband.appends).toEqual([])
      jest.advanceTimersByTime(200)
      expect(sideband.spoken).toEqual(['The task "Task A" failed before it started: Model access is disabled'])
      jest.advanceTimersByTime(20_000)
      expect(sideband.appends).toHaveLength(1)
      expect(lines.find((line) => line.type === "held")).toMatchObject({ kind: "outcome", holder: "user-speaking" })
      expect(lines.find((line) => line.type === "flushed")).toMatchObject({ kinds: ["outcome"], waitedMs: 2_700 })
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("speaking again during the pause keeps it held", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband } = harnessed
    try {
      heard(bridge, "user", true)
      await rejected(harnessed, "Task A")
      jest.advanceTimersByTime(1_000)
      heard(bridge, "user")
      jest.advanceTimersByTime(1_000)
      expect(sideband.appends).toEqual([])
      jest.advanceTimersByTime(300)
      expect(sideband.appends).toHaveLength(1)
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a started user turn holds output before any transcript arrives", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband } = harnessed
    try {
      bridge.handle({ kind: "turn", role: "user", id: "turn_1" })
      await rejected(harnessed, "Task A")
      jest.advanceTimersByTime(4_000)
      bridge.handle({ kind: "turn-delta", id: "turn_1" })
      jest.advanceTimersByTime(4_000)
      expect(sideband.appends).toEqual([])
      heard(bridge, "user", true)
      jest.advanceTimersByTime(1_300)
      expect(sideband.appends).toHaveLength(1)
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("GPT-Live's own reply holds output until it finishes", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband } = harnessed
    try {
      heard(bridge, "assistant")
      await rejected(harnessed, "Task A")
      jest.advanceTimersByTime(5_000)
      expect(sideband.appends).toEqual([])
      heard(bridge, "assistant", true)
      expect(sideband.appends).toHaveLength(1)
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("two outcomes during speech go out as one append", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband } = harnessed
    try {
      heard(bridge, "user")
      await rejected(harnessed, "Task A")
      await rejected(harnessed, "Task B")
      jest.advanceTimersByTime(1_300)
      expect(sideband.appends).toEqual([
        {
          text: 'The task "Task A" failed before it started: Model access is disabled\n\nThe task "Task B" failed before it started: Model access is disabled',
          channel: "speakable",
        },
      ])
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a held permission prompt goes first", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, stream } = harnessed
    try {
      heard(bridge, "user")
      await rejected(harnessed, "Task A")
      await emit(stream, {
        type: "permission.asked",
        data: { sessionID: "main", id: "per_1", action: "edit", resources: ["src/a.ts"] },
      })
      jest.advanceTimersByTime(1_300)
      expect(sideband.appends).toHaveLength(1)
      expect(sideband.spoken[0]).toStartWith("The coding session needs permission to edit src/a.ts.")
      expect(sideband.spoken[0]).toEndWith('The task "Task A" failed before it started: Model access is disabled')
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a held answer becomes silent context on its own hand-off when a newer request arrives", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, stream, prompt } = harnessed
    try {
      bridge.handle({ kind: "delegation", id: "del_a", text: "What is the build status?" })
      prompt().resolve({ id: "voice_inbox_a" })
      await flush()
      heard(bridge, "user")
      await emit(
        stream,
        { type: "session.inbox.delivered", data: { sessionID: "voice", inboxID: "voice_inbox_a" } },
        { type: "session.execution.started", data: { sessionID: "voice" } },
        { type: "session.text.ended", data: { sessionID: "voice", text: "The build is green." } },
        { type: "session.execution.succeeded", data: { sessionID: "voice" } },
      )
      expect(sideband.appends).toEqual([])
      bridge.handle({ kind: "delegation", id: "del_b", text: "Actually, run the tests" })
      expect(sideband.appends).toEqual([{ text: "The build is green.", channel: "commentary", delegationID: "del_a" }])
      jest.advanceTimersByTime(5_000)
      expect(sideband.appends).toHaveLength(1)
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a held answer is spoken on its own hand-off once the floor frees", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, stream, prompt } = harnessed
    try {
      bridge.handle({ kind: "delegation", id: "del_a", text: "What is the build status?" })
      prompt().resolve({ id: "voice_inbox_a" })
      await flush()
      heard(bridge, "user")
      await emit(
        stream,
        { type: "session.inbox.delivered", data: { sessionID: "voice", inboxID: "voice_inbox_a" } },
        { type: "session.execution.started", data: { sessionID: "voice" } },
        { type: "session.text.ended", data: { sessionID: "voice", text: "The build is green." } },
        { type: "session.execution.succeeded", data: { sessionID: "voice" } },
      )
      jest.advanceTimersByTime(1_300)
      expect(sideband.appends).toEqual([{ text: "The build is green.", channel: "speakable", delegationID: "del_a" }])
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a lost event stream during speech hangs up only after its message is sent", async () => {
    const { bridge, sideband, stream, prompt, ended } = harness()
    const pending = bridge.send("Inspect the project")
    prompt().resolve({ id: "inbox_1" })
    await pending
    jest.useFakeTimers()
    try {
      heard(bridge, "user")
      stream.end()
      await flush()
      expect(sideband.spoken).toEqual([])
      jest.advanceTimersByTime(1_300)
      expect(sideband.spoken).toHaveLength(1)
      jest.advanceTimersByTime(4_300)
      expect(ended()).toBe("")
      jest.advanceTimersByTime(200)
      expect(ended()).toContain("Lost the OpenCode event stream")
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("typed text is never held", () => {
    const { bridge, sideband } = harness()
    heard(bridge, "user")
    bridge.say("use the staging server")
    expect(sideband.spoken).toEqual(["The user typed: use the staging server"])
    bridge.close()
  })

  test("closing drops what is still held", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, lines } = harnessed
    try {
      heard(bridge, "user")
      await rejected(harnessed, "Task A")
      bridge.close()
      jest.advanceTimersByTime(5_000)
      expect(sideband.appends).toEqual([])
      expect(lines.find((line) => line.type === "dropped")).toMatchObject({ items: [{ kind: "outcome" }] })
    } finally {
      jest.useRealTimers()
    }
  })
})

/** A voice-session event, optionally with OpenCode's `created` time. */
function voiceEvent(type: string, data: Record<string, unknown> = {}, created?: number): SessionEvent {
  return { type, ...(created ? { created } : {}), data: { sessionID: "voice", ...data } }
}

describe("voice-agent hand-off steps", () => {
  test("are reported in order, from the request to GPT-Live speaking the answer", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, stream, prompt, steps, lines } = harnessed
    try {
      bridge.handle({ kind: "transcript", role: "user", text: "how is the build", final: true })
      bridge.handle({ kind: "delegation", id: "del_a", text: "What is the build status?" })
      prompt().resolve({ id: "voice_inbox_a" })
      await flush()
      await emit(
        stream,
        voiceEvent("session.inbox.delivered", { inboxID: "voice_inbox_a" }, 1_700_000_000_123),
        voiceEvent("session.execution.started"),
        voiceEvent("session.step.first-token"),
        voiceEvent("session.step.first-token"),
        voiceEvent("session.tool.input.started", { id: "call_1", name: "gptlive_main_status" }),
        voiceEvent("session.tool.called", { id: "call_1", input: { verbose: true } }),
        voiceEvent("session.tool.success", {
          id: "call_1",
          content: [{ type: "text", text: "The main session is idle." }],
        }),
        voiceEvent("session.step.ended", { tokens: { input: 100, output: 20, reasoning: 5 }, cost: 0.01 }),
        voiceEvent("session.text.ended", { text: "The build is green." }),
        voiceEvent("session.execution.succeeded"),
      )
      // The user's turn still holds the floor, so the answer has not gone out, let alone been spoken.
      expect(steps.map((item) => item.step.kind)).not.toContain("spoken")
      jest.advanceTimersByTime(1_300)
      expect(sideband.spoken).toEqual(["The build is green."])
      heard(bridge, "assistant")
      heard(bridge, "assistant")

      expect(steps.map((item) => item.step.kind)).toEqual([
        "received",
        "queued",
        "delivered",
        "started",
        "first-token",
        "tool",
        "tool",
        "replied",
        "spoken",
      ])
      expect(new Set(steps.map((item) => item.delegationID))).toEqual(new Set(["del_a"]))
      expect(steps[0].step).toEqual({
        kind: "received",
        request: "What is the build status?",
        context: { turns: 1, updates: 0, chars: expect.any(Number), first: true },
      })
      expect(steps[2].at).toBe(1_700_000_000_123)
      expect(steps.slice(5, 7).map((item) => item.step)).toEqual([
        { kind: "tool", id: "call_1", name: "gptlive_main_status", status: "running", args: '{"verbose":true}' },
        {
          kind: "tool",
          id: "call_1",
          name: "gptlive_main_status",
          status: "done",
          result: "The main session is idle.",
        },
      ])
      expect(steps[7].step).toEqual({
        kind: "replied",
        channel: "speakable",
        text: "The build is green.",
        outcome: "succeeded",
        tokens: { input: 100, output: 25 },
        cost: 0.01,
      })
      expect(lines.find((line) => line.type === "voice-reply")).toMatchObject({ delegationID: "del_a" })
      expect(lines.filter((line) => line.type === "voice-step")).toHaveLength(9)
      // The hand-off message itself never leaves the bridge.
      expect(JSON.stringify(steps)).not.toContain("<request>")
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a run that starts before delivery reports its steps once the hand-off is known", async () => {
    const { bridge, stream, prompt, steps } = harness()
    bridge.handle({ kind: "delegation", id: "del_a", text: "Stop the tests" })
    prompt().resolve({ id: "voice_inbox_a" })
    await flush()
    await emit(
      stream,
      voiceEvent("session.execution.started", {}, 1_700_000_000_000),
      voiceEvent("session.inbox.delivered", { inboxID: "voice_inbox_a" }, 1_700_000_000_050),
      voiceEvent("session.tool.input.started", { id: "call_1", name: "gptlive_main_stop" }),
      voiceEvent("session.tool.called", { id: "call_1", input: {} }),
      voiceEvent("session.tool.failed", { id: "call_1", error: { type: "x", message: "boom" } }),
      voiceEvent("session.execution.succeeded"),
    )
    expect(steps.map((item) => [item.step.kind, item.delegationID])).toEqual([
      ["received", "del_a"],
      ["queued", "del_a"],
      ["delivered", "del_a"],
      ["started", "del_a"],
      ["tool", "del_a"],
      ["tool", "del_a"],
      ["replied", "del_a"],
    ])
    expect(steps[3].at).toBe(1_700_000_000_000)
    expect(steps[4].step).toEqual({ kind: "tool", id: "call_1", name: "gptlive_main_stop", status: "running" })
    expect(steps[5].step).toMatchObject({ status: "failed", result: "boom" })
    expect(steps[6].step).toEqual({ kind: "replied", channel: "none", outcome: "succeeded" })
    bridge.close()
  })

  test("the transcript that frees the floor for an answer does not count as speaking it", async () => {
    jest.useFakeTimers()
    const harnessed = harness()
    const { bridge, sideband, stream, prompt, steps } = harnessed
    try {
      bridge.handle({ kind: "delegation", id: "del_a", text: "What is the build status?" })
      prompt().resolve({ id: "voice_inbox_a" })
      await flush()
      heard(bridge, "assistant")
      await emit(
        stream,
        voiceEvent("session.inbox.delivered", { inboxID: "voice_inbox_a" }),
        voiceEvent("session.execution.started"),
        voiceEvent("session.text.ended", { text: "The build is green." }),
        voiceEvent("session.execution.succeeded"),
      )
      heard(bridge, "assistant", true)
      expect(sideband.spoken).toEqual(["The build is green."])
      expect(steps.at(-1)?.step.kind).toBe("replied")
      heard(bridge, "assistant")
      expect(steps.at(-1)?.step.kind).toBe("spoken")
    } finally {
      jest.useRealTimers()
      bridge.close()
    }
  })

  test("a hand-off the voice session refuses is reported as failed", async () => {
    const { bridge, prompt, steps } = harness()
    bridge.handle({ kind: "delegation", id: "del_a", text: "Hello" })
    prompt().reject(new Error("session is gone"))
    await flush()
    expect(steps.map((item) => item.step)).toEqual([
      expect.objectContaining({ kind: "received" }),
      {
        kind: "replied",
        channel: "none",
        outcome: "failed",
        text: "Could not reach the voice agent: session is gone",
      },
    ])
    bridge.close()
  })
})
