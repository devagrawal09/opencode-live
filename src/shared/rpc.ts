import type { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

/** Type-only stand-in for Rpc.define, so the desktop bundle does not pull in the schema runtime. */
function define<const D extends Rpc.PortableDefinition>(definition: D): D {
  return definition
}

/** GPT-Live's voices. The first nine are the long-standing ones; the rest come from Codex's newer list. */
export const VOICES = [
  "cove",
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "marin",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const
export type Voice = (typeof VOICES)[number]

export const isVoice = (value: unknown): value is Voice => VOICES.includes(value as Voice)

/** A hint about speaking pace, added to GPT-Live's instructions; GPT-Live has no speed setting. */
export const PACES = ["normal", "slower", "faster"] as const
export type Pace = (typeof PACES)[number]

export const isPace = (value: unknown): value is Pace => PACES.includes(value as Pace)

export const Role = z.enum(["user", "assistant"])

export const CallState = z.enum(["connecting", "live", "closed", "error"])
export type CallState = z.infer<typeof CallState>

export const TaskStatus = z.enum(["queued", "running", "done", "failed", "cancelled"])
export type TaskStatus = z.infer<typeof TaskStatus>

/**
 * One step of a hand-off from GPT-Live to the voice agent, for the desktop's voice-agent view. Text is clipped, and
 * only the request and the sizes of the context it came with are sent: never prompts, history or reasoning.
 */
export const HandoffStep = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("received"),
    request: z.string(),
    context: z.object({
      /** Conversation turns since the previous hand-off. */
      turns: z.number(),
      /** Coding-session updates the voice agent had not seen. */
      updates: z.number(),
      /** Size of the whole message the voice agent got. */
      chars: z.number(),
      /** The first hand-off of the call, which also says the call started. */
      first: z.boolean(),
    }),
  }),
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("delivered") }),
  z.object({ kind: z.literal("started") }),
  z.object({ kind: z.literal("first-token") }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    status: z.enum(["running", "done", "failed"]),
    /** The input as clipped JSON. */
    args: z.string().optional(),
    /** The clipped text result, or the error message. */
    result: z.string().optional(),
  }),
  z.object({
    kind: z.literal("replied"),
    /** `none` when nothing went back to GPT-Live. */
    channel: z.enum(["speakable", "commentary", "none"]),
    text: z.string().optional(),
    outcome: z.enum(["succeeded", "failed", "interrupted"]),
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
    cost: z.number().optional(),
  }),
  /** GPT-Live started talking after the answer was sent: approximate. */
  z.object({ kind: z.literal("spoken") }),
])
export type HandoffStep = z.infer<typeof HandoffStep>

/**
 * Contract between the desktop window part (audio, UI) and the server plugin
 * (ChatGPT credentials, GPT-Live control channel, OpenCode session bridge).
 */
export const GptLive = define({
  id: "gptlive",
  methods: {
    start: {
      input: z.object({
        sessionID: z.string(),
        sdp: z.string(),
        voice: z.enum(VOICES).optional(),
        /** Speaking-pace hint for GPT-Live; the server's `pace` option when omitted. */
        pace: z.enum(PACES).optional(),
        /** Start a new voice session instead of continuing the linked one. */
        fresh: z.boolean().optional(),
        /** The user started the call by saying the wake word; their request follows at once. */
        wake: z.boolean().optional(),
      }),
      output: z.object({
        callID: z.string(),
        sdp: z.string(),
        model: z.string(),
        voice: z.string(),
        voiceSessionID: z.string(),
        voiceTitle: z.string(),
        /** 1 for the first call in this voice session. */
        call: z.number(),
        /** The last lines of the previous call, for context in the UI. */
        previous: z.array(z.object({ role: Role, text: z.string() })),
        /** Things to tell the user, e.g. a custom prompt that could not be read. */
        notices: z.array(z.string()).optional(),
      }),
      errors: {
        not_signed_in: z.object({ reason: z.string() }),
        busy: z.object({ callID: z.string() }),
        rejected: z.object({ status: z.number() }),
      },
    },
    stop: {
      input: z.object({ callID: z.string() }),
      output: z.object({ stopped: z.boolean() }),
    },
    status: {
      input: z.object({}),
      output: z.object({
        signedIn: z.boolean(),
        plan: z.string().optional(),
        callID: z.string().optional(),
        sessionID: z.string().optional(),
        voiceSessionID: z.string().optional(),
      }),
    },
    /** Heartbeat from the window that owns the call; calls whose window goes quiet are ended. */
    alive: {
      input: z.object({ callID: z.string() }),
      output: z.object({ active: z.boolean() }),
    },
    say: {
      input: z.object({ callID: z.string(), text: z.string() }),
      output: z.object({ sent: z.boolean() }),
    },
    /** Event types the window saw on the call's data channel, for the call log. */
    trace: {
      input: z.object({
        callID: z.string(),
        events: z.array(z.object({ type: z.string(), count: z.number(), keys: z.array(z.string()).optional() })),
      }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {
    state: {
      schema: z.object({
        callID: z.string(),
        state: CallState,
        message: z.string().optional(),
      }),
    },
    transcript: {
      schema: z.object({
        callID: z.string(),
        role: Role,
        text: z.string(),
        final: z.boolean(),
      }),
    },
    task: {
      schema: z.object({
        callID: z.string(),
        taskID: z.string(),
        text: z.string(),
        status: TaskStatus,
        detail: z.string().optional(),
      }),
    },
    activity: {
      schema: z.object({
        callID: z.string(),
        scope: z.enum(["voice", "main"]),
        busy: z.boolean(),
        label: z.string().optional(),
      }),
    },
    /** What the voice agent did with one hand-off, step by step. `at` is in milliseconds since the epoch. */
    handoff: {
      schema: z.object({
        callID: z.string(),
        delegationID: z.string(),
        at: z.number(),
        step: HandoffStep,
      }),
    },
  },
})
