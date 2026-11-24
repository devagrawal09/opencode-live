import type { TaskStatus } from "../shared/rpc"

/** One row of the call panel: a transcript line, a task handed to the coding session, or a notice. */
export type Entry =
  | {
      id: string
      kind: "user" | "assistant"
      text: string
      final: boolean
      /** From a previous call; shown dimmed. */
      past?: boolean
    }
  | { id: string; kind: "task"; taskID: string; text: string; status: TaskStatus; detail?: string }
  | { id: string; kind: "notice"; text: string; tone: "info" | "error" }
  /** Marks where a later call in the same window starts. */
  | { id: string; kind: "divider"; text: string }

const KEPT = 200

let counter = 0
export const nextID = () => `e${++counter}`

export function append(entries: readonly Entry[], entry: Entry): Entry[] {
  return [...entries.slice(-(KEPT - 1)), entry]
}

/**
 * Adds transcript text: deltas extend the role's open line, and a final transcript replaces it with the full text.
 * Returns the same array when nothing changes.
 */
export function transcript(
  entries: readonly Entry[],
  role: "user" | "assistant",
  text: string,
  final: boolean,
): readonly Entry[] {
  let index = -1
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 6; i--) {
    const candidate = entries[i]
    if (candidate.kind === role && !candidate.final) {
      index = i
      break
    }
  }
  if (index === -1) {
    const clean = final ? text.trim() : text.trimStart()
    if (!clean) return entries
    return append(entries, { id: nextID(), kind: role, text: clean, final })
  }
  const open = entries[index] as Extract<Entry, { kind: "user" | "assistant" }>
  const next = entries.slice()
  next[index] = { ...open, text: final ? text.trim() : open.text + text, final }
  return next
}

/**
 * The list a new call starts from. A window keeps what earlier calls showed and marks where this one starts; only the
 * first call in a window shows the stored turns from earlier calls, which the list would otherwise repeat.
 */
export function startCall(entries: readonly Entry[], label: string): Entry[] {
  if (entries.length === 0) return []
  return append(entries, { id: nextID(), kind: "divider", text: label })
}

export function withPast(entries: readonly Entry[], past: readonly Entry[], firstInWindow: boolean): Entry[] {
  return firstInWindow ? [...past, ...entries] : [...entries]
}

export function task(
  entries: readonly Entry[],
  taskID: string,
  text: string,
  status: TaskStatus,
  detail?: string,
): Entry[] {
  const index = entries.findIndex((entry) => entry.kind === "task" && entry.taskID === taskID)
  if (index === -1) return append(entries, { id: nextID(), kind: "task", taskID, text, status, detail })
  const next = entries.slice()
  next[index] = { ...(entries[index] as Extract<Entry, { kind: "task" }>), status, detail }
  return next
}

export function queued(entries: readonly Entry[]) {
  return entries.filter((entry) => entry.kind === "task" && entry.status === "queued").length
}
