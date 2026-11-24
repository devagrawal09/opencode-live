import type { HandoffStep } from "../shared/rpc"

/** One tool call the voice agent made for a hand-off. */
export interface HandoffTool {
  id: string
  name: string
  status: "running" | "done" | "failed"
  args?: string
  result?: string
  startedAt?: number
  endedAt?: number
}

export type HandoffTime = "received" | "queued" | "delivered" | "started" | "firstToken" | "replied" | "spoken"

type Replied = Extract<HandoffStep, { kind: "replied" }>
type Received = Extract<HandoffStep, { kind: "received" }>

/** What the voice agent did with one hand-off from GPT-Live, as the voice-agent view shows it. */
export interface Handoff {
  id: string
  request?: string
  context?: Received["context"]
  /** Milliseconds since the epoch, per step. */
  times: Partial<Record<HandoffTime, number>>
  tools: HandoffTool[]
  reply?: { channel: Replied["channel"]; text?: string }
  outcome?: Replied["outcome"]
  tokens?: Replied["tokens"]
  cost?: number
}

/** How many hand-offs the view keeps. */
export const HANDOFFS_KEPT = 50

const TIME_OF: Partial<Record<HandoffStep["kind"], HandoffTime>> = {
  received: "received",
  queued: "queued",
  delivered: "delivered",
  started: "started",
  "first-token": "firstToken",
  replied: "replied",
  spoken: "spoken",
}

/** Applies one step: updates its hand-off in place in the list, or adds it. Keeps the newest `HANDOFFS_KEPT`. */
export function applyStep(
  list: readonly Handoff[],
  event: { delegationID: string; at: number; step: HandoffStep },
): Handoff[] {
  const { delegationID, at, step } = event
  const index = list.findIndex((item) => item.id === delegationID)
  const current: Handoff = index >= 0 ? list[index] : { id: delegationID, times: {}, tools: [] }
  const next: Handoff = { ...current, times: { ...current.times } }
  const time = TIME_OF[step.kind]
  if (time) next.times[time] ??= at
  switch (step.kind) {
    case "received":
      next.request = step.request
      next.context = step.context
      break
    case "tool": {
      const tools = current.tools.slice()
      const position = tools.findIndex((tool) => tool.id === step.id)
      const before = position >= 0 ? tools[position] : undefined
      const tool: HandoffTool = {
        id: step.id,
        name: step.name !== "tool" || !before ? step.name : before.name,
        status: step.status,
        args: step.args ?? before?.args,
        result: step.result ?? before?.result,
        startedAt: before?.startedAt ?? (step.status === "running" ? at : undefined),
        endedAt: step.status === "running" ? undefined : at,
      }
      if (position >= 0) tools[position] = tool
      else tools.push(tool)
      next.tools = tools
      break
    }
    case "replied":
      next.reply = { channel: step.channel, ...(step.text ? { text: step.text } : {}) }
      next.outcome = step.outcome
      if (step.tokens) next.tokens = step.tokens
      if (step.cost !== undefined) next.cost = step.cost
      break
  }
  if (index >= 0) {
    const copy = list.slice()
    copy[index] = next
    return copy
  }
  return [...list.slice(-(HANDOFFS_KEPT - 1)), next]
}

export type HandoffPhase = "waiting" | "running" | Replied["outcome"]

export function phaseOf(handoff: Handoff): HandoffPhase {
  if (handoff.outcome) return handoff.outcome
  return handoff.times.delivered !== undefined || handoff.times.started !== undefined ? "running" : "waiting"
}

/** Received to replied, once both are known. */
export function totalOf(handoff: Handoff): number | undefined {
  const { received, replied } = handoff.times
  return received !== undefined && replied !== undefined ? Math.max(0, replied - received) : undefined
}

const ORDER: readonly Exclude<HandoffTime, "received">[] = [
  "queued",
  "delivered",
  "started",
  "firstToken",
  "replied",
  "spoken",
]

/** The steps after `received`, as offsets from it (or from the earliest step when it is unknown). */
export function timeline(handoff: Handoff): { key: Exclude<HandoffTime, "received">; offset: number }[] {
  const known = Object.values(handoff.times).filter((value): value is number => value !== undefined)
  if (!known.length) return []
  const origin = handoff.times.received ?? Math.min(...known)
  return ORDER.flatMap((key) => {
    const at = handoff.times[key]
    return at === undefined ? [] : [{ key, offset: at - origin }]
  })
}

/** Seconds with one decimal: `1.2s`. */
export function inSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1_000).toFixed(1)}s`
}

/** The timing line under a hand-off: `delivered +0.2s · … · reply +3.1s (commentary) · spoken ~+3.6s`. */
export function timingLine(
  handoff: Handoff,
  label: (key: Exclude<HandoffTime, "received">) => string,
  channel: (channel: Replied["channel"]) => string,
) {
  return timeline(handoff)
    .map(({ key, offset }) => {
      const text = `${label(key)} ${key === "spoken" ? "~" : ""}+${inSeconds(offset)}`
      return key === "replied" && handoff.reply ? `${text} (${channel(handoff.reply.channel)})` : text
    })
    .join(" · ")
}

/** How long a tool ran, once it finished. */
export function toolDuration(tool: HandoffTool): number | undefined {
  return tool.startedAt !== undefined && tool.endedAt !== undefined
    ? Math.max(0, tool.endedAt - tool.startedAt)
    : undefined
}
