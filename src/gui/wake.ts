/**
 * Listening for the wake word in a window, on the device: LiveKit WakeWord's "hey jarvis" model on ONNX Runtime's
 * WebAssembly, fed from an always-on microphone stream. Nothing leaves the window until the wake word is heard; then
 * the listener pauses, a short chime plays, and `wake` starts a call that shares this stream.
 */
import { createSignal } from "solid-js"

import { fromBase64 } from "./wake-assets"

/** The phrase the model listens for, as the UI shows it. */
export const WAKE_PHRASE = "Hey Jarvis"
/** The model's name in scores and detections. */
const MODEL = "hey_jarvis"
/** LiveKit's default: 0.5 to 2.5 false wakes an hour on conversational speech. */
const THRESHOLD = 0.5

export type WakeStatus = "off" | "loading" | "listening" | "paused" | "error"

export interface WakeOptions {
  /** The model and ONNX Runtime's WebAssembly, base64, from main. */
  assets(): Promise<{ model: string; runtime: string }>
  /** Asks the operating system for microphone access; true when granted. */
  microphone(): Promise<boolean>
  /** Whether a call is up in this window: listening waits for it to end. */
  busy(): boolean
  /** The wake word was heard. Listening stays paused until `resume()`. */
  wake(): void
  error(message: string): void
}

type Engine = Awaited<ReturnType<typeof loadEngine>>

async function loadEngine(assets: WakeOptions["assets"]) {
  // A dynamic import: Vite inlines it, but ONNX Runtime's module code then runs only here, in a window, and never
  // in Electron's main process, which evaluates the same bundle.
  const [{ env, WakeWordListener, WakeWordModel }, files] = await Promise.all([import("@livekit/wakeword"), assets()])
  // The WebAssembly comes as bytes, so ONNX Runtime fetches nothing; one thread needs no cross-origin isolation.
  env.wasm.wasmBinary = fromBase64(files.runtime)
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  const model = new WakeWordModel()
  await model.loadModel(fromBase64(files.model), MODEL)
  return { WakeWordListener, model }
}

/** Loaded once per window and kept: the model takes a moment to load and listening restarts after every call. */
let engine: Promise<Engine> | undefined

export function createWake(options: WakeOptions) {
  const [status, setStatus] = createSignal<WakeStatus>("off")
  const [error, setError] = createSignal<string>()
  let armed = false
  let paused = false
  let stream: MediaStream | undefined
  let context: AudioContext | undefined
  let listener: InstanceType<Engine["WakeWordListener"]> | undefined
  /** Bumped whenever listening stops, so a detection or failure from an earlier run is ignored. */
  let run = 0
  // Arming, pausing and resuming wait for each other: the listener's start and stop are asynchronous.
  let queue = Promise.resolve()
  const serial = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((cause: unknown) => fail(cause))
    return queue
  }

  const fail = (cause: unknown) => {
    const message = `Wake word listening stopped: ${cause instanceof Error ? cause.message : String(cause)}`
    armed = false
    release()
    setError(message)
    setStatus("error")
    options.error(message)
  }

  const release = () => {
    run++
    const current = listener
    listener = undefined
    void current?.stop()
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    void context?.close().catch(() => undefined)
    context = undefined
  }

  /** Starts the listener for one detection, unless a call is up or listening is paused. */
  const listen = async () => {
    if (!armed || paused || options.busy() || !listener || !stream || !context) return
    if (listener.isRunning) return
    await context.resume().catch(() => undefined)
    await listener.start({ source: stream, audioContext: context })
    setStatus("listening")
    void detect(listener, ++run)
  }

  /** Waits for this run's detection: pauses listening, chimes, and reports the wake word. */
  const detect = async (current: NonNullable<typeof listener>, id: number) => {
    try {
      await current.waitForDetection()
    } catch (cause) {
      // Stopping rejects the wait too; only a failure of a run still in progress is an error.
      if (id === run) fail(cause)
      return
    }
    if (id !== run) return
    // Paused before the call opens anything, so the call never races the listener for the microphone.
    void pause()
    if (context) chime(context)
    options.wake()
  }

  function arm() {
    if (armed) return queue
    armed = true
    setError(undefined)
    setStatus("loading")
    return serial(async () => {
      if (!armed) return
      engine ??= loadEngine(options.assets).catch((cause: unknown) => {
        engine = undefined
        throw cause
      })
      const allowed = await options.microphone()
      if (!allowed)
        throw new Error(
          "OpenCode has no microphone access. Allow it in System Settings › Privacy & Security › Microphone.",
        )
      const { WakeWordListener, model } = await engine
      if (!armed) return
      const opened = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      stream = opened
      // E.g. the microphone was unplugged: say so rather than listen to silence.
      opened.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (stream === opened) fail(new Error("the microphone stopped"))
      })
      context = new AudioContext()
      listener = new WakeWordListener(model, { threshold: THRESHOLD })
      if (!armed) return release()
      setStatus(paused || options.busy() ? "paused" : "listening")
      await listen()
    })
  }

  function disarm() {
    if (!armed && status() !== "error") return queue
    armed = false
    setError(undefined)
    setStatus("off")
    return serial(async () => release())
  }

  /** Stops feeding the model while a call is up; the microphone stays open for the call to share. */
  function pause() {
    paused = true
    if (armed) setStatus("paused")
    return serial(async () => {
      run++
      await listener?.stop()
    })
  }

  function resume() {
    paused = false
    return serial(listen)
  }

  /** The listening microphone, for a call to share instead of opening the microphone a second time. */
  const shared = () => {
    const track = stream?.getAudioTracks()[0]
    return track && track.readyState === "live" ? stream : undefined
  }

  return { status, error, arm, disarm, pause, resume, stream: shared }
}

export type Wake = ReturnType<typeof createWake>

/** Two short rising tones: the wake word was heard and a call is starting. */
function chime(context: AudioContext) {
  const start = context.currentTime + 0.01
  for (const [offset, frequency] of [
    [0, 880],
    [0.12, 1320],
  ] as const) {
    const tone = context.createOscillator()
    const gain = context.createGain()
    tone.type = "sine"
    tone.frequency.value = frequency
    gain.gain.setValueAtTime(0, start + offset)
    gain.gain.linearRampToValueAtTime(0.15, start + offset + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.11)
    tone.connect(gain).connect(context.destination)
    tone.start(start + offset)
    tone.stop(start + offset + 0.12)
  }
}
