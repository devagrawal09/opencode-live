/**
 * The call's audio in a desktop window: microphone, WebRTC peer and speaker, replacing the native helper.
 *
 * It negotiates what `native/src/transport.rs` does: one send/receive Opus audio track and the `oai-events` data
 * channel, with non-trickle ICE (the offer carries every candidate). Chromium's WebRTC stack provides echo
 * cancellation, noise suppression and gain control through `getUserMedia`.
 */

const NEGOTIATION_TIMEOUT = 20_000
/** Host candidates gather in milliseconds; past this the offer goes out with what it has. */
const GATHER_TIMEOUT = 3_000
const LEVEL_INTERVAL = 50

export type AudioFailure = "microphone" | "connection" | "dropped"

export class AudioError extends Error {
  constructor(
    readonly reason: AudioFailure,
    message: string,
  ) {
    super(message)
    this.name = "AudioError"
  }
}

export interface AudioCallbacks {
  /** Microphone and speaker levels, 0 to 1, about 20 times a second. */
  levels(mic: number, speaker: number): void
  /** The connection dropped after it was up. */
  dropped(message: string): void
  /** Something the user should know that does not end the call. */
  warning(message: string): void
  /** An event GPT-Live sent on the data channel, parsed. */
  event?(event: Record<string, unknown> & { type: string }): void
}

export class WindowAudio {
  private readonly peer = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  })
  private readonly channel: RTCDataChannel
  private readonly speaker = new Audio()
  private readonly context = new AudioContext()
  private readonly samples = new Float32Array(256)
  private stream?: MediaStream
  private micMeter?: AnalyserNode
  private speakerMeter?: AnalyserNode
  private meter?: ReturnType<typeof setInterval>
  private connected = false
  private closed = false

  constructor(private readonly callbacks: AudioCallbacks) {
    // A media element pulls the remote track in Chromium; a Web Audio-only sink can stay silent.
    this.speaker.autoplay = true
    this.channel = this.peer.createDataChannel("oai-events", { ordered: true })
    // GPT-Live sends its events here too; the server plugin acts on the control channel's, these are only traced.
    this.channel.addEventListener("close", this.onChannelClose)
    this.channel.addEventListener("message", this.onChannelMessage)
    this.peer.addEventListener("track", this.onTrack)
    this.peer.addEventListener("connectionstatechange", this.onPeerState)
  }

  private readonly onChannelClose = () => this.drop("The call's event channel closed")

  private readonly onChannelMessage = (message: MessageEvent) => {
    if (typeof message.data !== "string" || !this.callbacks.event) return
    try {
      const event = JSON.parse(message.data) as Record<string, unknown>
      if (typeof event.type === "string") this.callbacks.event(event as Record<string, unknown> & { type: string })
    } catch {}
  }
  private readonly onTrack = (event: RTCTrackEvent) => this.play(event.track)
  private readonly onPeerState = () => {
    const state = this.peer.connectionState
    if (state === "failed" || state === "closed") this.drop(`Audio connection ${state}`)
  }

  /**
   * Opens the microphone and returns the SDP offer with every ICE candidate in it. With `shared`, an open microphone
   * stream (the wake word listener's), the call sends a clone of its track instead: muting and closing the call
   * then never touch the shared stream, and the microphone is not opened twice.
   */
  async offer(shared?: MediaStream): Promise<string> {
    await this.context.resume().catch(() => undefined)
    const sharedTrack = shared?.getAudioTracks().find((track) => track.readyState === "live")
    const stream = sharedTrack
      ? new MediaStream([sharedTrack.clone()])
      : await navigator.mediaDevices
          .getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          })
          .catch((cause: unknown) => {
            throw new AudioError(
              "microphone",
              `Could not open the microphone${cause instanceof Error && cause.message ? `: ${cause.message}` : ""}.`,
            )
          })
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop())
      throw new AudioError("connection", "The call was closed")
    }
    this.stream = stream
    const track = stream.getAudioTracks()[0]
    if (!track) throw new AudioError("microphone", "No microphone track is available.")
    track.addEventListener("ended", () => this.drop("The microphone stopped"))
    this.micMeter = this.analyser(stream)
    this.peer.addTransceiver(track, { direction: "sendrecv", streams: [stream] })
    await this.peer.setLocalDescription(await this.peer.createOffer())
    await this.gathered()
    const sdp = this.peer.localDescription?.sdp
    if (!sdp) throw new AudioError("connection", "Could not create the WebRTC offer")
    return sdp
  }

  /** Applies GPT-Live's answer and resolves once audio and the event channel are up. */
  async answer(sdp: string): Promise<void> {
    await this.peer.setRemoteDescription({ type: "answer", sdp })
    await this.ready()
    this.connected = true
    this.meter = setInterval(
      () => this.callbacks.levels(this.level(this.micMeter), this.level(this.speakerMeter)),
      LEVEL_INTERVAL,
    )
  }

  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.meter)
    this.channel.removeEventListener("close", this.onChannelClose)
    this.channel.removeEventListener("message", this.onChannelMessage)
    this.peer.removeEventListener("track", this.onTrack)
    this.peer.removeEventListener("connectionstatechange", this.onPeerState)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.speaker.pause()
    this.speaker.srcObject = null
    try {
      if (this.channel.readyState === "open") this.channel.send(JSON.stringify({ type: "session.close" }))
    } catch {
      // Already closing.
    }
    this.channel.close()
    this.peer.close()
    void this.context.close().catch(() => undefined)
  }

  private drop(message: string) {
    if (this.closed || !this.connected) return
    this.close()
    this.callbacks.dropped(message)
  }

  private play(track: MediaStreamTrack) {
    const stream = new MediaStream([track])
    this.speaker.srcObject = stream
    this.speakerMeter = this.analyser(stream)
    void this.speaker
      .play()
      .catch(() =>
        this.callbacks.warning("The window could not play GPT-Live's audio. Click in the window to allow it."),
      )
  }

  private gathered() {
    if (this.peer.iceGatheringState === "complete") return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.peer.removeEventListener("icegatheringstatechange", check)
        resolve()
      }
      const check = () => {
        if (this.peer.iceGatheringState === "complete") done()
      }
      const timer = setTimeout(done, GATHER_TIMEOUT)
      this.peer.addEventListener("icegatheringstatechange", check)
    })
  }

  private ready() {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.closed) return finish(new AudioError("connection", "The call was closed"))
        const state = this.peer.connectionState
        if (state === "failed" || state === "closed")
          return finish(new AudioError("connection", "Could not connect the audio to GPT-Live"))
        if (this.channel.readyState === "open" && state === "connected") finish()
      }
      const finish = (error?: Error) => {
        clearTimeout(timer)
        clearInterval(poll)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () => finish(new AudioError("connection", "Timed out connecting to GPT-Live")),
        NEGOTIATION_TIMEOUT,
      )
      const poll = setInterval(check, 50)
      check()
    })
  }

  private analyser(stream: MediaStream) {
    const node = this.context.createAnalyser()
    node.fftSize = 256
    this.context.createMediaStreamSource(stream).connect(node)
    return node
  }

  private level(node?: AnalyserNode) {
    if (!node) return 0
    node.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const value of this.samples) sum += value * value
    // RMS of speech sits well under 0.3; the square root spreads it over the meter.
    return Math.min(1, Math.sqrt(Math.sqrt(sum / this.samples.length) * 3))
  }
}
