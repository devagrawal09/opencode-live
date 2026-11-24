import type { Plugin } from "@opencode/plugin"

import type { HandoffStep, TaskStatus } from "../shared/rpc"
import { clip, speakable } from "./context"
import { Floor } from "./floor"
import type { LiveEvent, Sideband } from "./live"
import type { CallLog } from "./log"

type Context = Plugin.Context

/** Something to be spoken that waits while the floor is busy. */
type Outgoing =
  | { kind: "permission"; text: string }
  /** The voice agent's reply; with a delegation ID it answers that hand-off. */
  | { kind: "reply"; text: string; delegationID?: string }
  /** A task outcome; a newer one for the same task replaces it. */
  | { kind: "outcome"; text: string; taskID?: string }

/** Order within one merged append: permission prompts first. */
const SPEAK_ORDER: Record<Outgoing["kind"], number> = { permission: 0, reply: 1, outcome: 2 }

export interface BridgeEvents {
  transcript(role: "user" | "assistant", text: string, final: boolean): void
  task(taskID: string, text: string, status: TaskStatus, detail?: string): void
  activity(scope: "voice" | "main", busy: boolean, label?: string): void
  closed(reason: string): void
  error(message: string): void
  /** The user asked (by voice) to hang up. */
  end(reason: string): void
  /** A finished conversation turn, for persistence across calls. */
  turn?(role: "user" | "assistant", text: string): void
  /** One step of a hand-off to the voice agent; `at` is in milliseconds since the epoch. */
  handoff?(delegationID: string, at: number, step: HandoffStep): void
}

interface Task {
  id: string
  text: string
  inboxID?: string
  status: TaskStatus
}

export type TaskOutcome = "done" | "failed" | "cancelled" | "lost"

export interface SpokenOutcome {
  id: string
  status: TaskStatus
  detail?: string
  spoken?: string
}

/** One outcome per still-open task. Pure: the caller applies the status. Queued tasks are included only when asked. */
export function taskOutcomes(
  tasks: readonly Task[],
  outcome: TaskOutcome,
  options: { error?: string; result?: string; cancelledByUser?: boolean; includeQueued?: boolean } = {},
): SpokenOutcome[] {
  const open = tasks.filter((task) => task.status === "running" || (options.includeQueued && task.status === "queued"))
  return open.map((task) => {
    const status: TaskStatus = outcome === "done" ? "done" : outcome === "cancelled" ? "cancelled" : "failed"
    const label = clip(task.text, 120)
    if (outcome === "done") {
      return {
        id: task.id,
        status,
        spoken: options.result
          ? `Finished the task "${label}". Outcome: ${options.result}`
          : `Finished the task "${label}".`,
      }
    }
    if (outcome === "failed") {
      const detail = clip(options.error ?? "unknown error", 300)
      return { id: task.id, status, detail, spoken: `The task "${label}" failed: ${detail}` }
    }
    if (outcome === "lost") {
      return {
        id: task.id,
        status,
        detail: "event stream lost",
        spoken: `Lost track of the task "${label}" when the OpenCode event stream disconnected. Its result is unknown.`,
      }
    }
    return {
      id: task.id,
      status,
      spoken: options.cancelledByUser ? undefined : `Work on "${label}" was stopped.`,
    }
  })
}

/** How many events of each unhandled type are logged individually before only being counted. */
const TRACE_FIRST = 3

const TOOL_LABELS: Record<string, string> = {
  read: "reading files",
  write: "writing a file",
  edit: "editing code",
  apply_patch: "editing code",
  bash: "running a command",
  shell: "running a command",
  grep: "searching the code",
  glob: "looking for files",
  list: "browsing files",
  webfetch: "reading a web page",
  websearch: "searching the web",
  task: "working with a subagent",
  subagent: "working with a subagent",
  todowrite: "updating its plan",
  skill: "loading a skill",
  patch: "editing code",
  gptlive_main_send: "handing work to OpenCode",
  gptlive_main_status: "checking on OpenCode",
  gptlive_main_read: "reading the session",
  gptlive_main_stop: "stopping OpenCode",
  gptlive_main_permissions: "checking permissions",
  gptlive_main_permission_reply: "answering a permission",
  gptlive_end_call: "ending the call",
}

export function toolLabel(name: string) {
  const key = name.toLowerCase()
  if (TOOL_LABELS[key]) return TOOL_LABELS[key]
  const suffix = key.split(/[_.]/).pop() ?? key
  return TOOL_LABELS[suffix] ?? `using ${name.replaceAll("_", " ")}`
}

/**
 * Connects one GPT-Live call to two OpenCode sessions:
 * - the voice session, which receives everything GPT-Live delegates and whose agent
 *   answers conversational questions or hands real work over with the plugin tools;
 * - the main session the call was started from, which only ever receives explicit tasks.
 */
export class Bridge {
  private readonly tasks = new Map<string, Task>()
  private readonly voiceInbox = new Map<string, string>()
  private readonly abort = new AbortController()
  private currentDelegation: string | undefined
  private voiceText = ""
  private voiceDelegated = false
  private mainBusy = false
  private mainLabel: string | undefined
  private mainText = ""
  private cancelRequested = false
  private closed = false
  private ending = false
  private taskCounter = 0
  /** Finished conversation turns since the last hand-off to the voice agent. */
  private turns: { role: "user" | "assistant"; text: string }[] = []
  /** Coding-session updates the voice agent has not seen yet. */
  private updates: string[] = []
  private introduced = false
  private streamLost = false
  private lostTimer: ReturnType<typeof setTimeout> | undefined
  /** Unhandled GPT-Live event types seen this call, by "source:type". */
  private readonly traced = new Map<string, number>()
  /** Whether the user or GPT-Live is talking; speakable output waits while it is busy. */
  private readonly floor = new Floor()
  /** Role of each turn GPT-Live started, so its deltas count for the right speaker. */
  private readonly turnRoles = new Map<string, "user" | "assistant">()
  /** Speakable output held until the floor is free. */
  private outbox: Outgoing[] = []
  private heldSince: number | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Runs once everything queued so far has been sent. */
  private drained: (() => void) | undefined
  /** Steps of the current voice run, held until its hand-off is known: a run can start before inbox delivery. */
  private voiceSteps: { at: number; step: HandoffStep }[] = []
  private voiceRunning = false
  private voiceFirstToken = false
  /** Tool names in the current voice run by call ID; `session.tool.called` carries only the ID. */
  private readonly voiceTools = new Map<string, string>()
  private voiceUsage: { input: number; output: number; cost: number } | undefined
  /** The hand-off whose spoken answer was sent last, until GPT-Live starts saying it. */
  private speaking: string | undefined

  constructor(
    private readonly ctx: Context,
    readonly mainSessionID: string,
    readonly voiceSessionID: string,
    private readonly sideband: Sideband,
    private readonly events: BridgeEvents,
    private readonly log?: CallLog,
    private readonly call = 1,
  ) {
    void this.watchSessions()
  }

  handle(event: LiveEvent) {
    switch (event.kind) {
      case "transcript":
        // Before pump: a reply this transcript frees the floor for has not been spoken yet.
        if (event.role === "assistant") this.markSpoken()
        this.floor.onTranscript(event.role, event.final, Date.now())
        this.pump()
        this.events.transcript(event.role, event.text, event.final)
        if (event.final && event.text.trim()) {
          this.turns.push({ role: event.role, text: event.text.trim() })
          if (this.turns.length > 40) this.turns = this.turns.slice(-40)
          this.log?.write({ type: "turn", role: event.role, text: event.text.trim() })
          this.events.turn?.(event.role, event.text.trim())
        }
        return
      case "turn":
        this.trace("sideband", "turn.created")
        if (event.id) {
          if (this.turnRoles.size >= 100) this.turnRoles.clear()
          this.turnRoles.set(event.id, event.role)
        }
        this.floor.onTurnStarted(event.role, Date.now())
        this.pump()
        return
      case "turn-delta": {
        this.trace("sideband", "turn.delta")
        const role = this.turnRoles.get(event.id)
        if (!role) return
        this.floor.onTurnActivity(role, Date.now())
        this.pump()
        return
      }
      case "output-audio":
        this.trace("sideband", "session.output_audio.delta")
        this.floor.onOutputAudio(Date.now())
        this.pump()
        return
      case "delegation":
        // A newer request wins: an answer still waiting for the floor stays only as context for its own hand-off.
        this.supersedeReply()
        this.pump()
        void this.toVoice(event.id, event.text).catch((error) =>
          this.events.error(`Could not reach the voice agent: ${String(error)}`),
        )
        return
      case "closed":
        this.events.closed(event.reason ?? "closed")
        return
      case "error":
        this.events.error(event.message)
        return
      case "started":
        this.trace("sideband", "session.started")
        return
      case "speech-cleared":
        this.trace("sideband", "output_audio_buffer.cleared")
        return
      case "other":
        this.trace("sideband", event.type, event.keys)
        return
    }
  }

  /**
   * Records GPT-Live events the plugin does not act on, to learn what the endpoint sends (e.g. speech start/stop):
   * the first few of each type with their field names, then only a count, written when the call closes.
   */
  trace(source: "sideband" | "window", type: string, keys?: readonly string[], count = 1) {
    const key = `${source}:${type}`
    const seen = this.traced.get(key) ?? 0
    this.traced.set(key, seen + count)
    if (seen < TRACE_FIRST)
      this.log?.write({ type: "live-event", source, event: type, ...(keys?.length ? { keys } : {}) })
  }

  private async toVoice(delegationID: string, raw: string) {
    const request = raw.trim()
    if (!request) return
    const receivedAt = Date.now()
    this.log?.write({ type: "handoff", delegationID, request, turns: this.turns, updates: this.updates })
    const first = !this.introduced
    const text = handoff(request, this.turns, this.updates, first ? this.call : undefined)
    // Only the request and the sizes of its context: the hand-off itself stays in the voice session.
    this.emitStep(delegationID, receivedAt, {
      kind: "received",
      request: clip(request, 600),
      context: { turns: this.turns.length, updates: this.updates.length, chars: text.length, first },
    })
    this.introduced = true
    this.turns = []
    this.updates = []
    let entry: unknown
    try {
      entry = await this.ctx.session.prompt({
        sessionID: this.voiceSessionID as never,
        text,
        delivery: "queue",
        metadata: { gptLive: { delegationID } },
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.emitStep(delegationID, Date.now(), {
        kind: "replied",
        channel: "none",
        outcome: "failed",
        text: clip(`Could not reach the voice agent: ${reason}`, 1_200),
      })
      throw error
    }
    this.emitStep(delegationID, Date.now(), { kind: "queued" })
    const inboxID = (entry as { id?: string } | undefined)?.id
    if (inboxID) this.voiceInbox.set(inboxID, delegationID)
  }

  /** A step of the current voice run, held until the run's hand-off is known. */
  private voiceStep(at: number, step: HandoffStep) {
    if (this.currentDelegation) this.emitStep(this.currentDelegation, at, step)
    else if (this.voiceSteps.length < 100) this.voiceSteps.push({ at, step })
  }

  private emitStep(delegationID: string, at: number, step: HandoffStep) {
    this.log?.write({ type: "voice-step", delegationID, atMs: at, ...step })
    this.events.handoff?.(delegationID, at, step)
  }

  /** GPT-Live started talking after a spoken answer went out, so it is (most likely) saying it. */
  private markSpoken() {
    const delegationID = this.speaking
    if (!delegationID) return
    this.speaking = undefined
    this.emitStep(delegationID, Date.now(), { kind: "spoken" })
  }

  /** Tool: send a task or message to the main session. */
  async send(raw: string, delivery: "queue" | "steer" = "queue"): Promise<string> {
    const text = raw.trim()
    if (!text) throw new Error("text is empty; write the brief you want to send")
    if (this.streamLost)
      throw new Error("The OpenCode event stream is gone, so this call can no longer report a result.")
    this.log?.write({ type: "task", delivery, text })
    const id = `task_${++this.taskCounter}`
    const record: Task = { id, text, status: "queued" }
    this.tasks.set(id, record)
    this.events.task(id, text, "queued")
    try {
      const entry = await this.ctx.session.prompt({
        sessionID: this.mainSessionID as never,
        text,
        delivery,
        metadata: { gptLive: { voiceSessionID: this.voiceSessionID, taskID: id } },
      })
      record.inboxID = (entry as { id?: string }).id
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.failUnaccepted(record, reason)
      return `Failed before the coding session started: ${clip(reason, 300)}`
    }
    if (delivery === "steer" && this.mainBusy)
      return "Delivered to the main session's current work as a steering message. The outcome will be announced when it finishes."
    return this.mainBusy
      ? "Queued in the main session. It is busy with earlier work, so this starts next. The result will be announced when it is done."
      : "Sent to the main session, which has started on it. The result will be announced when it is done."
  }

  /** Tool: recent main-session conversation, including which tools were used. */
  async read(limit = 8): Promise<string> {
    const messages = (await this.ctx.session.context({ sessionID: this.mainSessionID as never })) as readonly Record<
      string,
      unknown
    >[]
    const lines: string[] = []
    for (const message of messages) {
      if (message.type === "user" && typeof message.text === "string") {
        lines.push(`User: ${clip(message.text.trim(), 500)}`)
      } else if (message.type === "assistant" && Array.isArray(message.content)) {
        const parts = message.content as Record<string, unknown>[]
        const tools = parts.filter((part) => part.type === "tool").map((part) => String(part.name))
        const text = parts
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
          .trim()
        if (tools.length) lines.push(`Agent used tools: ${[...new Set(tools)].join(", ")}`)
        if (text) lines.push(`Agent: ${clip(speakable(text, 1_500), 1_500)}`)
      }
    }
    const recent = lines.slice(-Math.max(1, Math.min(limit, 30)) * 2)
    return recent.length ? recent.join("\n") : "The main session has no messages yet."
  }

  /** Tool: pending permission requests in the main session. */
  async permissions(): Promise<string> {
    const requests = (await this.ctx.permission
      .list({ sessionID: this.mainSessionID as never })
      .catch(() => [])) as readonly { id: string; action: string; resources: readonly string[]; message?: string }[]
    if (!requests.length) return "The main session has no pending permission requests."
    return requests
      .map(
        (request) =>
          `- id ${request.id}: wants to ${request.action} ${request.resources.join(", ")}${request.message ? ` (${request.message})` : ""}`,
      )
      .join("\n")
  }

  /** Tool: answer a pending permission request. */
  async replyPermission(requestID: string, decision: "once" | "always" | "reject", message?: string) {
    await this.ctx.permission.reply({
      sessionID: this.mainSessionID as never,
      requestID: requestID as never,
      decision,
      ...(message ? { message } : {}),
    })
    return decision === "reject" ? "Rejected the request." : `Allowed the request (${decision}).`
  }

  /** Tool: describe what the main session is doing. */
  status(): string {
    const queued = [...this.tasks.values()].filter((task) => task.status === "queued")
    const running = [...this.tasks.values()].find((task) => task.status === "running")
    const lines = [
      this.mainBusy
        ? `The main session is working${running ? ` on: ${clip(running.text, 200)}` : " on something the user typed"}.`
        : "The main session is idle.",
      this.mainBusy && this.mainLabel ? `Right now it is ${this.mainLabel}.` : undefined,
      queued.length ? `Queued tasks: ${queued.map((task) => clip(task.text, 80)).join("; ")}.` : undefined,
      !this.mainBusy && this.mainText ? `Its last reply was: ${clip(speakable(this.mainText), 600)}` : undefined,
    ]
    return lines.filter(Boolean).join("\n")
  }

  /** Tool: interrupt the main session. */
  async cancel(): Promise<string> {
    this.cancelRequested = true
    const result = await this.ctx.session
      .interrupt({ sessionID: this.mainSessionID as never, resume: false })
      .catch(() => undefined)
    for (const task of this.tasks.values()) {
      if (task.status === "queued" || task.status === "running") this.setStatus(task, "cancelled")
    }
    return (result as { interrupted?: boolean } | undefined)?.interrupted
      ? "The main session stopped its current work."
      : "The main session was not running anything."
  }

  private setStatus(task: Task, status: TaskStatus, detail?: string) {
    task.status = status
    this.events.task(task.id, task.text, status, detail)
  }

  private async watchSessions() {
    const signal = this.abort.signal
    try {
      for await (const event of this.ctx.event.subscribe({ signal })) {
        const data = (event as { data?: Record<string, unknown> }).data
        if (!data) continue
        if (signal.aborted) return
        if (data.sessionID === this.voiceSessionID)
          this.onVoiceEvent(event.type, data, eventTime((event as { created?: unknown }).created))
        else if (data.sessionID === this.mainSessionID) this.onMainEvent(event.type, data)
      }
      if (!signal.aborted) this.lostEvents("The OpenCode event stream ended")
    } catch (error) {
      if (!signal.aborted) this.lostEvents(error instanceof Error ? error.message : String(error))
    }
  }

  /** Outstanding tasks can no longer receive their terminal event, so say so once and end the call. */
  private lostEvents(reason: string) {
    if (this.streamLost || this.closed) return
    this.streamLost = true
    this.events.error(`Lost the OpenCode event stream: ${reason}`)
    this.applyOutcomes(taskOutcomes([...this.tasks.values()], "lost", { includeQueued: true }))
    // Hang up only after GPT-Live has had time to say what happened, as endCall does: the wait starts once the
    // message has actually been sent, which may be after the user finishes talking.
    this.ending = true
    this.drained = () => {
      this.lostTimer = setTimeout(() => this.events.end(`Lost the OpenCode event stream: ${reason}`), 4_500)
    }
    this.pump()
  }

  private onVoiceEvent(type: string, data: Record<string, unknown>, at = Date.now()) {
    switch (type) {
      case "session.inbox.delivered": {
        const delegation = this.voiceInbox.get(String(data.inboxID))
        if (delegation) {
          this.voiceInbox.delete(String(data.inboxID))
          const previous = this.currentDelegation
          this.currentDelegation = delegation
          this.emitStep(delegation, at, { kind: "delivered" })
          // Delivered into a run already answering an earlier hand-off: this one is being worked on from now.
          if (this.voiceRunning && previous && previous !== delegation)
            this.emitStep(delegation, at, { kind: "started" })
          for (const held of this.voiceSteps.splice(0)) this.emitStep(delegation, held.at, held.step)
        }
        return
      }
      case "session.execution.started":
        this.voiceText = ""
        this.voiceDelegated = false
        this.voiceSteps = []
        this.voiceRunning = true
        this.voiceFirstToken = false
        this.voiceTools.clear()
        this.voiceUsage = undefined
        this.voiceStep(at, { kind: "started" })
        this.events.activity("voice", true, "thinking")
        return
      case "session.step.first-token":
        if (this.voiceFirstToken) return
        this.voiceFirstToken = true
        this.voiceStep(at, { kind: "first-token" })
        return
      case "session.step.ended": {
        const tokens = data.tokens as { input?: unknown; output?: unknown; reasoning?: unknown } | undefined
        const usage = (this.voiceUsage ??= { input: 0, output: 0, cost: 0 })
        usage.input += finite(tokens?.input)
        usage.output += finite(tokens?.output) + finite(tokens?.reasoning)
        usage.cost += finite(data.cost)
        return
      }
      case "session.tool.input.started":
        if (typeof data.name !== "string") return
        if (typeof data.id === "string") this.voiceTools.set(data.id, data.name)
        if (data.name === "gptlive_main_send") this.voiceDelegated = true
        this.events.activity("voice", true, toolLabel(data.name))
        return
      case "session.tool.called": {
        const id = String(data.id)
        this.voiceStep(at, {
          kind: "tool",
          id,
          name: this.voiceTools.get(id) ?? "tool",
          status: "running",
          args: brief(data.input, 300),
        })
        return
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const id = String(data.id)
        const failed = type === "session.tool.failed"
        const result = failed
          ? String((data.error as { message?: unknown } | undefined)?.message ?? "failed")
          : contentText(data.content)
        this.voiceStep(at, {
          kind: "tool",
          id,
          name: this.voiceTools.get(id) ?? "tool",
          status: failed ? "failed" : "done",
          ...(result ? { result: clip(result, 400) } : {}),
        })
        return
      }
      case "session.text.ended":
        if (typeof data.text === "string" && data.text.trim()) this.voiceText = data.text
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.events.activity("voice", false)
        const text = speakable(this.voiceText, 1_200)
        const failed = type === "session.execution.failed"
        const message = failed
          ? `The voice agent hit an error: ${clip((data.error as { message?: string })?.message ?? "unknown", 200)}`
          : text
        // After handing work off, GPT-Live has already acknowledged; the result is spoken later.
        const channel = (this.voiceDelegated || !this.currentDelegation) && !failed ? "commentary" : "speakable"
        const usage = this.voiceUsage
        this.voiceStep(at, {
          kind: "replied",
          channel: message ? channel : "none",
          ...(message ? { text: clip(message, 1_200) } : {}),
          outcome: failed ? "failed" : type === "session.execution.interrupted" ? "interrupted" : "succeeded",
          ...(usage ? { tokens: { input: usage.input, output: usage.output }, cost: usage.cost } : {}),
        })
        if (message) {
          this.log?.write({ type: "voice-reply", delegationID: this.currentDelegation, channel, text: message })
          // Commentary is silent, so only spoken answers wait for the floor.
          if (channel === "speakable")
            this.speak({ kind: "reply", text: message, delegationID: this.currentDelegation })
          else this.sideband.append(message, channel, this.currentDelegation)
        }
        this.currentDelegation = undefined
        this.voiceText = ""
        this.voiceSteps = []
        this.voiceRunning = false
        return
      }
    }
  }

  private onMainEvent(type: string, data: Record<string, unknown>) {
    switch (type) {
      case "permission.asked": {
        const resources = Array.isArray(data.resources) ? data.resources.join(", ") : ""
        const spoken = `The coding session needs permission to ${String(data.action ?? "continue")}${resources ? ` ${clip(resources, 160)}` : ""}. Ask the user whether to allow it once, always, or reject it.`
        this.speak({ kind: "permission", text: spoken })
        this.notifyVoice(`${spoken} Request id: ${String(data.id)}.`)
        return
      }
      case "session.inbox.delivered": {
        const task = [...this.tasks.values()].find((item) => item.inboxID === data.inboxID)
        if (task && task.status === "queued") this.setStatus(task, "running")
        return
      }
      case "session.inbox.cancelled": {
        // The user removed a waiting voice task (e.g. from the queued prompts list); it will never run.
        const task = [...this.tasks.values()].find((item) => item.inboxID === data.inboxID)
        if (!task || (task.status !== "queued" && task.status !== "running")) return
        this.setStatus(task, "cancelled")
        this.notifyVoice(`The task "${clip(task.text, 120)}" was removed from the queue before it ran.`)
        return
      }
      case "session.execution.started":
        this.promoteQueued()
        this.mainBusy = true
        this.mainText = ""
        this.mainLabel = "thinking"
        this.cancelRequested = false
        this.events.activity("main", true, this.mainLabel)
        return
      case "session.tool.input.started":
        if (typeof data.name !== "string") return
        this.mainLabel = toolLabel(data.name)
        this.events.activity("main", true, this.mainLabel)
        return
      case "session.text.ended":
        if (typeof data.text === "string" && data.text.trim()) this.mainText = data.text
        return
      case "session.execution.succeeded":
        this.finishMain("done")
        return
      case "session.execution.failed":
        this.finishMain("failed", (data.error as { message?: string } | undefined)?.message)
        return
      case "session.execution.interrupted":
        this.finishMain("cancelled")
        return
    }
  }

  /** A task rejected before OpenCode delivered it still needs one spoken failure. */
  private failUnaccepted(task: Task, error: string) {
    if (task.status !== "queued") return
    this.setStatus(task, "failed", error)
    this.announce(`The task "${clip(task.text, 120)}" failed before it started: ${clip(error, 300)}`, task.id)
  }

  /**
   * A run can start before inbox delivery. Promote the next queued task only when nothing is already running, and only
   * one OpenCode has accepted: a task whose prompt is still pending may yet be rejected, and must not take another
   * run's result.
   */
  private promoteQueued() {
    if ([...this.tasks.values()].some((task) => task.status === "running")) return
    const next = [...this.tasks.values()].find((task) => task.status === "queued" && task.inboxID)
    if (next) this.setStatus(next, "running")
  }

  private finishMain(outcome: "done" | "failed" | "cancelled", error?: string) {
    this.mainBusy = false
    this.mainLabel = undefined
    this.events.activity("main", false)
    this.applyOutcomes(
      taskOutcomes([...this.tasks.values()], outcome, {
        error,
        result: speakable(this.mainText),
        cancelledByUser: this.cancelRequested,
      }),
    )
  }

  private applyOutcomes(outcomes: readonly SpokenOutcome[]) {
    for (const outcome of outcomes) {
      const task = this.tasks.get(outcome.id)
      if (!task || (task.status !== "queued" && task.status !== "running")) continue
      this.setStatus(task, outcome.status, outcome.detail)
      if (outcome.spoken) this.announce(outcome.spoken, outcome.id)
    }
  }

  /** Speak an outcome once and keep it for the voice agent's next hand-off. */
  private announce(spoken: string, taskID?: string) {
    this.speak({ kind: "outcome", text: spoken, taskID })
    this.notifyVoice(spoken)
  }

  /** Speaks now when the floor is free; otherwise holds it until the user and GPT-Live have finished talking. */
  private speak(item: Outgoing) {
    if (this.closed) return
    if (item.kind === "outcome" && item.taskID)
      this.outbox = this.outbox.filter((queued) => queued.kind !== "outcome" || queued.taskID !== item.taskID)
    if (item.kind === "reply" && item.delegationID) this.supersedeReply()
    this.outbox.push(item)
    const now = Date.now()
    const holder = this.floor.holder(now)
    if (holder) {
      this.heldSince ??= now
      this.log?.write({ type: "held", kind: item.kind, holder, queued: this.outbox.length, text: clip(item.text, 120) })
    }
    this.pump()
  }

  /** Sends what is queued if the floor is free, or checks again when it should be. */
  private pump() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (this.closed) return
    if (this.outbox.length) {
      const now = Date.now()
      if (this.floor.busy(now)) {
        this.flushTimer = setTimeout(() => this.pump(), this.floor.freeAt(now) - now)
        return
      }
      this.flush(now)
    }
    this.heldSince = undefined
    const drained = this.drained
    this.drained = undefined
    drained?.()
  }

  /** Everything queued as one append, so GPT-Live takes one turn for it: permission prompts first. */
  private flush(now: number) {
    const items = this.outbox.toSorted((a, b) => SPEAK_ORDER[a.kind] - SPEAK_ORDER[b.kind])
    this.outbox = []
    const reply = items.find((item) => item.kind === "reply" && item.delegationID)
    const delegationID = reply?.kind === "reply" ? reply.delegationID : undefined
    this.sideband.append(items.map((item) => item.text).join("\n\n"), "speakable", delegationID)
    if (delegationID) this.speaking = delegationID
    if (this.heldSince !== undefined)
      this.log?.write({
        type: "flushed",
        kinds: items.map((item) => item.kind),
        waitedMs: now - this.heldSince,
        ...(delegationID ? { delegationID } : {}),
      })
  }

  /** A held answer to an earlier hand-off becomes silent context on that hand-off instead of being spoken. */
  private supersedeReply() {
    const index = this.outbox.findIndex((item) => item.kind === "reply" && item.delegationID)
    if (index < 0) return
    const [reply] = this.outbox.splice(index, 1)
    if (reply?.kind !== "reply" || !reply.delegationID) return
    this.log?.write({ type: "superseded", delegationID: reply.delegationID, text: clip(reply.text, 120) })
    this.sideband.append(reply.text, "commentary", reply.delegationID)
  }

  /** Queue a coding-session update for the voice agent's next hand-off (no extra turn). */
  private notifyVoice(text: string) {
    this.log?.write({ type: "update", text })
    this.updates.push(text)
    if (this.updates.length > 10) this.updates = this.updates.slice(-10)
  }

  /** Tool: hang up after the goodbye has been spoken. */
  endCall(): string {
    if (this.ending) return "The call is already ending."
    this.ending = true
    this.log?.write({ type: "end-requested" })
    setTimeout(() => this.events.end("Ended by voice"), 4_500)
    return "The call ends in a few seconds. Reply with a very short goodbye and nothing else."
  }

  /** Lets the user type a message straight to the voice layer. */
  say(text: string) {
    this.sideband.append(`The user typed: ${text}`, "speakable")
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.lostTimer)
    clearTimeout(this.flushTimer)
    if (this.outbox.length)
      this.log?.write({
        type: "dropped",
        items: this.outbox.map((item) => ({ kind: item.kind, text: clip(item.text, 120) })),
      })
    this.outbox = []
    this.drained = undefined
    if (this.traced.size) this.log?.write({ type: "live-events", counts: Object.fromEntries(this.traced) })
    this.abort.abort()
    this.sideband.close()
  }
}

/** An OpenCode event's `created` time in milliseconds; now when it is missing. */
export function eventTime(created: unknown) {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return Date.now()
  // Seconds, should an event ever carry them.
  return created < 1e12 ? created * 1_000 : created
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Clipped JSON of a tool's input; nothing for an empty one. */
function brief(value: unknown, max: number) {
  try {
    const text = JSON.stringify(value)
    return text === undefined || text === "{}" ? undefined : clip(text, max)
  } catch {
    return undefined
  }
}

/** The text parts of a tool result; files by name. */
function contentText(content: unknown) {
  if (!Array.isArray(content)) return ""
  return content
    .map((part: { type?: unknown; text?: unknown; name?: unknown; uri?: unknown }) =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : part?.type === "file"
          ? `[file ${String(part.name ?? part.uri ?? "")}]`
          : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim()
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/**
 * Builds the message the voice agent receives for one hand-off: the conversation since
 * the previous hand-off (turns GPT-Live answered itself included), coding-session updates
 * it has not seen, and the request as the voice model understood it.
 */
export function handoff(
  request: string,
  turns: readonly { role: "user" | "assistant"; text: string }[],
  updates: readonly string[],
  call?: number,
) {
  const parts: string[] = []
  if (call !== undefined) {
    parts.push(
      call > 1
        ? `<call_started number="${call}">A new voice call started. Earlier calls in this session are above; the user may refer back to them.</call_started>`
        : `<call_started number="1">The first voice call in this session started.</call_started>`,
    )
  }
  if (turns.length) {
    const lines = turns.map((turn) => `${turn.role === "user" ? "user" : "you"}: ${escape(clip(turn.text, 1_200))}`)
    parts.push(`<conversation_since_last_message>\n${lines.join("\n")}\n</conversation_since_last_message>`)
  }
  if (updates.length) {
    parts.push(
      `<coding_session_updates>\n${updates.map((update) => `- ${escape(update)}`).join("\n")}\n</coding_session_updates>`,
    )
  }
  parts.push(`<request>${escape(request)}</request>`)
  return parts.join("\n")
}
