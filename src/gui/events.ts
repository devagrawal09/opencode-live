/** GPT-Live data-channel events, as the panel's optional debug view shows them. */
export interface LiveEventRow {
  id: number
  /** Milliseconds since the call started. */
  at: number
  type: string
  /** A short summary of the useful fields: roles, ids, timings and clipped text. Never audio. */
  detail: string
}

/** How many events the debug view keeps. */
export const EVENTS_KEPT = 200

/** High-rate audio events: counted, but left out of the list so it stays readable. */
export function noisy(type: string) {
  return /audio\.(delta|append)$/.test(type)
}

type Json = Record<string, unknown>

const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** Summarizes one event for the debug view: the fields that tell who, which turn, when, and what was said. */
export function describeEvent(event: Json): string {
  const parts: string[] = []
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(`${label}=${clip(value.trim().replace(/\s+/g, " "), 60)}`)
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${label}=${value}`)
  }
  const turn = record(event.turn)
  const item = record(event.item)
  add("role", turn?.role ?? item?.role)
  add("item", item?.type)
  add("target", item?.target)
  add("turn", event.turn_id ?? turn?.id)
  add("reason", event.reason)
  add("offset", event.offset_ms)
  if (typeof event.start_ms === "number" && typeof event.end_ms === "number")
    parts.push(`ms=${event.start_ms}–${event.end_ms}`)
  add("text", typeof event.delta === "string" ? event.delta : (turn?.transcript ?? item?.text))
  const error = record(event.error)
  add("error", error?.message ?? event.message)
  return parts.join(" · ")
}

/** Event types and how often each was seen, most frequent first. */
export function countsOf(counts: ReadonlyMap<string, number>) {
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
