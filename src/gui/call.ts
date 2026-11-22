import type { Context, IpcClient } from "@opencode/plugin/gui"
import { batch, createSignal } from "solid-js"
import { createStore } from "solid-js/store"

import { GptLive, type Voice } from "../shared/rpc"
import type { Host } from "./contract"
import { append, nextID, queued, task, transcript, type Entry } from "./entries"
import { WindowAudio } from "./transport"

export type Phase = "idle" | "connecting" | "live" | "closing" | "error"

/** The session a call talks about, and the server that runs it. */
export interface Target {
  server: string
  sessionID: string
  directory: string
}

/** The selection the next prompt would use, copied to the session so voice-sent tasks keep it. */
export interface CallModel {
  providerID: string
  modelID: string
  variant?: string
}

export interface CallState {
  phase: Phase
  callID?: string
  target?: Target
  voiceSessionID?: string
  voice?: string
  model?: string
  voiceTitle?: string
  call?: number
  muted: boolean
  liveAt: number
  voiceActivity?: string
  mainActivity?: string
  queued: number
  error?: string
}

type Client = Context["client"]
const rpcOf = (client: Client) => client.rpc(GptLive)
type Rpc = ReturnType<typeof rpcOf>

interface Options {
  /** The OpenCode client of a server, read at call time (a restarted server gets a new one). */
  client(server: string): Client
  host: IpcClient<(typeof Host)["spec"]>
  toast(title: string, variant: "default" | "error"): void
  voice?: Voice
}

const HEARTBEAT = 5_000

/**
 * One window's voice call, as `src/tui/controller.ts` is for the terminal: audio in the window, the server part's
 * RPC, heartbeats, and the state the panel and the composer pill render.
 */
export function createCall(options: Options) {
  const [state, setState] = createStore<CallState>({ phase: "idle", muted: false, liveAt: 0, queued: 0 })
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const [levels, setLevels] = createSignal({ mic: 0, speaker: 0 })

  let audio: WindowAudio | undefined
  let rpc: Rpc | undefined
  let unsubscribe: Array<() => void> = []
  let pulse: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let tearingDown = false
  let disposed = false

  const active = () => state.phase === "connecting" || state.phase === "live" || state.phase === "closing"
  const location = () => (state.target ? { location: { directory: state.target.directory } } : undefined)

  const notice = (text: string, tone: "info" | "error") =>
    setEntries((list) => append(list, { id: nextID(), kind: "notice", text, tone }))

  const markLive = () => {
    setState({ phase: "live", liveAt: Date.now() })
    notice('Connected. Start talking. Say "end the call" or run /voice to hang up.', "info")
  }

  const mine = (event: { data: { callID: string } }) =>
    !disposed && active() && state.phase !== "closing" && event.data.callID === state.callID

  const subscribe = (client: Rpc) => {
    unsubscribe = [
      client.events.on("state", (event) => {
        if (!mine(event)) return
        const { state: next, message } = event.data
        if (next === "live" && state.phase === "connecting") markLive()
        if (next === "error" && message) notice(message, "error")
        if (next === "closed") void teardown(undefined, message && message !== "closed" ? message : undefined)
      }),
      client.events.on("transcript", (event) => {
        if (!mine(event)) return
        setEntries((list) => transcript(list, event.data.role, event.data.text, event.data.final))
      }),
      client.events.on("task", (event) => {
        if (!mine(event)) return
        const { taskID, text, status, detail } = event.data
        const next = task(entries(), taskID, text, status, detail)
        batch(() => {
          setEntries(next)
          setState("queued", queued(next))
        })
      }),
      client.events.on("activity", (event) => {
        if (!mine(event)) return
        const label = event.data.busy ? (event.data.label ?? "working") : undefined
        setState(event.data.scope === "voice" ? "voiceActivity" : "mainActivity", label)
      }),
    ]
  }

  const heartbeat = (callID: string) => {
    clearInterval(pulse)
    pulse = setInterval(async () => {
      if (state.callID !== callID || !active()) return clearInterval(pulse)
      const reply = await rpc?.alive({ callID }, location()).catch(() => undefined)
      // The server no longer knows this call (e.g. it restarted): close it here too.
      if (reply && !reply.active && state.callID === callID && active()) await teardown(undefined, "Call closed")
    }, HEARTBEAT)
  }

  const report = (up: boolean) => {
    const target = state.target
    void options.host
      .call({
        active: up,
        callID: up ? state.callID : undefined,
        directory: target?.directory,
        sidecar: target?.server === "sidecar",
      })
      .catch(() => undefined)
  }

  async function start(target: Target, input: { fresh?: boolean; model?: CallModel; voice?: Voice } = {}) {
    if (disposed || active()) return
    const attempt = ++generation
    const current = () => !disposed && generation === attempt
    batch(() => {
      setState({
        phase: "connecting",
        callID: undefined,
        target,
        voiceSessionID: undefined,
        voice: undefined,
        model: undefined,
        voiceTitle: undefined,
        call: undefined,
        muted: false,
        liveAt: 0,
        voiceActivity: undefined,
        mainActivity: undefined,
        queued: 0,
        error: undefined,
      })
      setEntries([])
      setLevels({ mic: 0, speaker: 0 })
    })
    notice("Connecting to GPT-Live…", "info")
    try {
      const client = options.client(target.server)
      const allowed = await options.host.microphone().catch(() => true)
      if (!current()) return
      if (!allowed)
        throw new Error(
          "OpenCode has no microphone access. Allow it in System Settings › Privacy & Security › Microphone.",
        )
      if (input.model)
        await client.session
          .switchModel({
            sessionID: target.sessionID,
            model: {
              providerID: input.model.providerID,
              id: input.model.modelID,
              ...(input.model.variant ? { variant: input.model.variant } : {}),
            },
          })
          .catch(() => undefined)
      if (!current()) return
      const media = new WindowAudio({
        levels: (mic, speaker) => setLevels({ mic, speaker }),
        dropped: (message) => void stop(message),
        warning: (message) => notice(message, "error"),
      })
      audio = media
      const offer = await media.offer()
      if (!current()) return
      rpc = rpcOf(client)
      subscribe(rpc)
      const call = await rpc.start(
        { sessionID: target.sessionID, sdp: offer, voice: input.voice ?? options.voice, fresh: input.fresh },
        { location: { directory: target.directory } },
      )
      if (!current()) {
        // stop() could not know the call ID while this request was pending.
        await rpc.stop({ callID: call.callID }, { location: { directory: target.directory } }).catch(() => undefined)
        return
      }
      const past = call.previous.map((turn): Entry => ({
        id: nextID(),
        kind: turn.role,
        text: turn.text,
        final: true,
        past: true,
      }))
      batch(() => {
        setState({
          callID: call.callID,
          voiceSessionID: call.voiceSessionID,
          voice: call.voice,
          model: call.model,
          voiceTitle: call.voiceTitle,
          call: call.call,
        })
        setEntries((list) => [...past, ...list])
      })
      for (const text of call.notices ?? []) notice(text, "info")
      heartbeat(call.callID)
      report(true)
      await media.answer(call.sdp)
      if (!current()) return
      if (state.phase === "connecting") markLive()
    } catch (error) {
      if (current()) await teardown(describeError(error))
    }
  }

  async function stop(failure?: string) {
    generation++
    if (!active()) return
    setState("phase", "closing")
    const callID = state.callID
    if (callID) await rpc?.stop({ callID }, location()).catch(() => undefined)
    await teardown(failure)
  }

  async function teardown(failure?: string, reason?: string) {
    if (state.phase === "idle" || state.phase === "error" || tearingDown) return
    generation++
    tearingDown = true
    try {
      clearInterval(pulse)
      pulse = undefined
      for (const off of unsubscribe.splice(0)) off()
      audio?.close()
      audio = undefined
      report(false)
      const lasted = state.liveAt ? Date.now() - state.liveAt : 0
      batch(() => {
        setState({
          phase: failure ? "error" : "idle",
          error: failure,
          muted: false,
          voiceActivity: undefined,
          mainActivity: undefined,
        })
        setLevels({ mic: 0, speaker: 0 })
      })
      if (failure) {
        notice(failure, "error")
        options.toast(failure, "error")
        return
      }
      const minutes = Math.max(1, Math.round(lasted / 60_000))
      const summary = `Call ended${reason ? ` (${reason.toLowerCase()})` : ""}${
        lasted ? ` after ${lasted < 60_000 ? "under a minute" : `${minutes} min`}` : ""
      }.`
      notice(summary, "info")
      options.toast(summary, "default")
    } finally {
      tearingDown = false
    }
  }

  function toggleMute() {
    if (!active() || !audio) return
    const muted = !state.muted
    setState("muted", muted)
    audio.mute(muted)
  }

  /** Whether the session is part of the current call: its coding session or its voice session. */
  function owns(sessionID: string | undefined) {
    return !!sessionID && active() && (sessionID === state.target?.sessionID || sessionID === state.voiceSessionID)
  }

  async function dispose() {
    await stop()
    disposed = true
  }

  return { state, entries, levels, active, owns, start, stop, toggleMute, dispose }
}

export type Call = ReturnType<typeof createCall>

/** Readable text for errors from audio, RPC or the network, which are not always Errors. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; data?: { message?: unknown }; error?: unknown }
    if (typeof value.message === "string") return value.message
    if (typeof value.data?.message === "string") return value.data.message
    if (value.error !== undefined && value.error !== error) return describeError(value.error)
    try {
      return JSON.stringify(error)
    } catch {}
  }
  return String(error)
}
