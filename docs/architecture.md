# Architecture

opencode-gpt-live is one npm package with three parts: a server plugin, a terminal plugin, and a native audio helper.
This guide explains what each part owns, how a call flows through them, and the constraints that shaped the design.

```mermaid
flowchart LR
  subgraph Terminal["OpenCode terminal (per window)"]
    tui["Terminal plugin<br/>src/tui"]
    host["gpt-live-host<br/>native/"]
  end
  subgraph Server["OpenCode server (shared)"]
    server["Server plugin<br/>src/server"]
    voice["Voice session"]
    main["Main session"]
  end
  openai["GPT-Live<br/>chatgpt.com / api.openai.com"]

  tui <-->|"stdio NDJSON"| host
  tui <-->|"RPC gptlive"| server
  host <-->|"WebRTC audio + data channel"| openai
  server <-->|"call setup (HTTPS), control (WebSocket)"| openai
  server --> voice
  voice -->|"gptlive_main_* tools"| main
```

## Repository map

| Path                      | What lives there                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `index.ts`                | Server plugin entry.                                                                         |
| `tui.ts`                  | Terminal plugin entry. The only file that imports `@opentui/core` at runtime (see below).    |
| `src/shared/rpc.ts`       | The `GptLive` RPC contract between the two plugins: methods, events and their schemas.       |
| `src/server/index.ts`     | Server plugin: tools for the voice agent, the call lifecycle, voice-session continuity.      |
| `src/server/live.ts`      | The GPT-Live wire contract: call creation, headers, the control WebSocket and its events.    |
| `src/server/bridge.ts`    | Connects GPT-Live to OpenCode: hand-offs, coding-session updates, permissions, ending calls. |
| `src/server/prompt.ts`    | Loads the system prompts: built-in section folders, user overrides, placeholders.            |
| `src/server/prompts/`     | The prompts for GPT-Live and the voice agent, one Markdown file per section.                 |
| `src/server/context.ts`   | Conversation history quoted as data, and agent text made speakable.                          |
| `src/server/auth.ts`      | Reads OpenCode's ChatGPT OAuth sign-in.                                                      |
| `src/server/log.ts`       | The per-call JSONL log.                                                                      |
| `src/tui/index.ts`        | Terminal plugin: commands, keys, slots, starting calls.                                      |
| `src/tui/controller.ts`   | Call state machine in the terminal, helper lifecycle, RPC events, heartbeats.                |
| `src/tui/helper.ts`       | Finds, downloads (with checksum verification) and drives the native helper.                  |
| `src/tui/ui.ts`           | The status strip, transcript panel, aura view, footer badge and the frame clock.             |
| `src/tui/aura.ts`         | The aura renderer: RGBA frames from voice level and speaker.                                 |
| `src/tui/surface.ts`      | Where frames are shown: kitty graphics, herdr's graphics API, or half-block text.            |
| `src/tui/herdr.ts`        | herdr's `pane.graphics.stream` client.                                                       |
| `native/src/main.rs`      | Helper entry and command loop.                                                               |
| `native/src/transport.rs` | WebRTC peer: SDP offer/answer, Opus RTP, the data channel.                                   |
| `native/src/audio/`       | Devices (CPAL), resampling, echo cancellation and noise suppression (sonora), Opus.          |
| `native/src/duck.rs`      | Turning other apps' audio down during calls, per operating system.                           |
| `scripts/`                | Release packaging, the headless end-to-end call, and the README aura renderer.               |

## Life of a call

1. **Start.** `/voice` (or the key) runs `start()` in `src/tui/index.ts`. With no session open, it creates one and
   waits for its prompt to mount. The transcript panel opens.
2. **Helper.** The controller locates `gpt-live-host` (platform package, cache, or local build; otherwise it downloads
   the release asset and checks `SHA256SUMS`), spawns it and sends `start`. The helper opens the microphone and
   speaker, starts ducking other apps, creates the WebRTC peer and replies with an SDP `offer`.
3. **Call setup.** The controller calls the server plugin's `start` RPC with the offer. The server resolves the ChatGPT
   sign-in, finds or creates the voice session linked to this main session, and posts the offer and the session
   configuration to GPT-Live's calls endpoint. The response carries the SDP answer and the call ID.
4. **Connect.** The controller passes the answer to the helper (`answer`). Audio flows. In the background the server
   joins the call's control WebSocket and starts the bridge.
5. **Talking.** GPT-Live transcribes and replies in real time. Transcripts reach the panel as RPC `transcript` events.
6. **Hand-offs.** When GPT-Live needs to think or act, the bridge sends a message to the voice session. Each hand-off
   contains `<conversation_since_last_message>`, `<coding_session_updates>` (what the main session did since the last
   hand-off) and `<request>`, plus `<call_started>` on the first one of a call. The voice agent answers in the first
   person; its reply goes back to GPT-Live to be spoken.
7. **Work.** The voice agent's tools act on the main session implicitly (its ID is never in the prompt):
   `gptlive_main_send` (queue or steer), `gptlive_main_status`, `gptlive_main_read`, `gptlive_main_stop`,
   `gptlive_main_permissions`, `gptlive_main_permission_reply` and `gptlive_end_call`. They are hidden from every other
   session. Permission requests in the main session are spoken to the user as they arrive.
8. **End.** The user says "end the call" (the voice agent calls `gptlive_end_call`), runs `/voice`, or presses the
   key. The server closes the bridge and control channel and emits `closed`; the controller closes the helper, which
   restores other apps' audio.

### Robustness

- **Heartbeats.** The OpenCode server is shared by every window. The controller sends `alive` every 5 seconds; the
  server ends any call whose window has been quiet for 20 seconds, so a crashed or killed window never leaves a call
  running.
- **Takeover.** Starting a call while another is active ends the old one instead of refusing.
- **Lost event stream.** Task outcomes arrive on OpenCode's event stream. If it ends or fails, open tasks are reported
  once as lost, new tasks are refused, and the call hangs up a few seconds later, once GPT-Live has said so.
- **Not talking over the user.** Answers, task outcomes and permission prompts wait while the user or GPT-Live is
  talking (`src/server/floor.ts`: turn starts, transcripts and output audio), then go out as one append, permission
  prompts first. Typed messages are never held. `held`, `flushed`, `superseded` and `dropped` lines in the call log
  show the waits.
- **Continuity.** Plugin storage keeps `link/<mainSessionID>` (the voice session and call count) and
  `turns/<voiceSessionID>` (the last turns, replayed as background at the next call). `/voice-new` starts a fresh
  voice session.

## The desktop part

`gui.tsx` is the `./gui-experimental` entry for OpenCode Desktop, bundled by `vite build` into
`dist/gui-experimental.cjs`. It replaces both the terminal plugin and the native helper and talks to the same server
plugin over the `GptLive` RPC, on the server of the session the call is about.

| Path                     | What lives there                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/gui/window.tsx`     | Window setup: commands, the voice call panel, the composer pill, the settings page.     |
| `src/gui/call.ts`        | The window's call state, RPC calls and events, heartbeats; the desktop `controller.ts`. |
| `src/gui/handoffs.ts`    | The voice-agent tab's model: each hand-off's steps, tools, reply and timing.            |
| `src/gui/transport.ts`   | WebRTC in the window: microphone, peer, `oai-events` data channel, speaker, levels.     |
| `src/gui/wake.ts`        | The wake word listener: the always-on microphone, the model, pausing during calls.      |
| `src/gui/wake-assets.ts` | The wake word's model and ONNX Runtime WebAssembly: pinned, downloaded, cached.         |
| `src/gui/idle.ts`        | When a call started from the wake word has gone quiet.                                  |
| `src/gui/main.ts`        | Electron main: microphone access, background throttling, hanging up on close, wake.     |
| `src/gui/contract.ts`    | The `Ipc` between a window and main.                                                    |

The window negotiates what the helper does (one Opus send/receive track, the `oai-events` channel, every ICE candidate
in the offer), opening the microphone first so the offer carries real host candidates. While a call is up, main turns
off the window's background throttling so heartbeats keep their 5-second rhythm, and, for calls on the app's own
server, it ends the call as soon as its window closes rather than when the heartbeats stop.

### Wake word

With the wake word on (a global preference), main lets one window listen at a time (`Host` state `free`, `mine` or
`other`; turning it on in a window takes it over) and keeps that window unthrottled. The window opens the microphone
with echo cancellation, noise suppression and gain control and feeds it to LiveKit WakeWord's `WakeWordListener`
(an AudioWorklet, 16 kHz, one model step per 80 ms) on onnxruntime-web, single-threaded, in the window. Nothing is sent
anywhere before a detection.

The bundle cannot carry the model or the WebAssembly: it is one CommonJS file evaluated from a string, and inlining
them would add about 30 MB of base64. Main downloads both once (`wake-assets.ts`: the GitHub release model and the
jsDelivr WebAssembly of the exact onnxruntime-web version the bundle is built with, each checked against a pinned
SHA-256) into the app's data folder and hands them to the window as base64 over the `Ipc`. The window passes the bytes
to `env.wasm.wasmBinary` and `loadModel`, so ONNX Runtime fetches nothing. `vite.config.ts` replaces ONNX Runtime's
`import.meta.url` with a constant so the build does not inline the WebAssembly, and fails if it does.

On a detection the listener stops, a chime plays, and the call starts with `wake: true` on the current session, unless
the server already has a call up (another window's). The call sends a clone of the listening microphone track, so
the microphone is not opened twice and muting or ending the call leaves the listener's stream alone. The server adds a
sentence to GPT-Live's instructions: the call began from the wake word, so no greeting. While live, `IdleClock` hangs
the call up after 20 seconds without transcripts, hand-off steps or task updates, with GPT-Live silent, nothing queued
and nothing working. After any call ends, listening resumes if the wake word is still on.

The call panel has a collapsible **Voice agent** column beside the transcript. The bridge reports each hand-off's steps as RPC
`handoff` events (`received`, `queued`, `delivered`, `started`, `first-token`, `tool`, `replied`, an approximate
`spoken`), timed with OpenCode's event times, and mirrors them to the call log as `voice-step` lines. Only the request,
the sizes of its context, clipped tool input and output, and the reply leave the bridge: never prompts, history or
reasoning.

## The native helper

`gpt-live-host` exists because WebRTC with echo cancellation needs real-time audio threads, which a TypeScript plugin
cannot provide. It holds no credentials: the plugin exchanges the SDP offer for an answer and hands the answer back.

### Protocol

Newline-delimited JSON on stdin and stdout (`native/src/protocol.rs`).

| Commands (plugin → helper)               | Events (helper → plugin)                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| `start { input?, output?, duckOthers? }` | `ready { version, protocol }`                              |
| `answer { sdp }`                         | `audio { input, output }` (device names and formats)       |
| `mute { muted }`                         | `offer { sdp }`, `connected`, `peer`                       |
| `clear` (drop queued speaker audio)      | `levels` (microphone and speaker levels for the UI)        |
| `devices`                                | `event { data }` (GPT-Live data-channel messages)          |
| `close`                                  | `muted`, `devices`, `warning`, `error { fatal }`, `closed` |

`input` and `output` accept `{ "file": "path.wav" }` for headless testing, and `output` also accepts `"none"`.

### Audio pipeline

```text
Capture:  device rate -> 48 kHz -> echo cancellation, noise suppression (high), high-pass filter, gain (10 ms) -> Opus (20 ms) -> RTP
Playback: RTP -> Opus decode (48 kHz) -> device rate -> speaker ring (60 ms prebuffer)
```

The rendered speaker signal feeds back as the echo-cancellation reference, which is what makes speakers usable
without headphones.

### Ducking

| OS      | Method                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | A voice-processing I/O unit with maximum "other audio" ducking, the mechanism FaceTime uses. It ducks audio from other processes only. |
| Windows | Every other app's audio session volume drops to 20%, like the Volume Mixer sliders.                                                    |
| Linux   | Every other PipeWire/PulseAudio playback stream drops to 20%, via `pactl`.                                                             |

On Windows and Linux, streams that start during the call are lowered too, and a stream is restored only if its volume
is still what the helper set.

## The terminal UI

The UI is built imperatively from OpenTUI renderables and redrawn by a frame clock (`Frames` in `src/tui/ui.ts`). Two
constraints drive this:

- **One runtime copy of OpenTUI.** OpenCode maps runtime packages such as `@opentui/core` to its own copies only for
  imports in the plugin's entry file. `tui.ts` imports the module and passes it in through `createTuiPlugin(core)`;
  every other file uses type-only imports and `core()` from `src/tui/core.ts`. Importing `@opentui/core` anywhere else
  would create renderables from a second copy that the host cannot draw.
- **No JSX.** For the same reason the UI does not use Solid; views are plain objects with `update(now)`,
  `animating(now)` and optional `interval()`, `suspend()` and `dispose()`.

The frame clock runs only while something animates, at the fastest interval any animating view asks for (33 ms for
the aura).

### The aura

`AuraCanvas` (`src/tui/aura.ts`) draws a ring woven from four translucent strands. Per frame it computes each strand's
radius, width and colour for 720 angle buckets, then shades only the pixels near the ring, so a 192 × 192 frame
takes about 2 ms. Your voice gives fine, quick ripples spinning one way in cyan; GPT-Live gives broad, slow swells
spinning the other way in violet. The level driving it is smoothed with a 40 ms attack and 200 ms release.

`pickSurface` (`src/tui/surface.ts`) chooses how to show it:

| Surface  | When                                             | How                                                            |
| -------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `herdr`  | `HERDR_ENV=1`, not inside tmux, screen or Zellij | RGBA frames over herdr's `pane.graphics.stream` socket, 30 fps |
| `kitty`  | The renderer reports kitty graphics              | Kitty graphics commands over an empty slot, 30 fps (see below) |
| `blocks` | Everywhere else                                  | Half-block characters, rendered at 3× and averaged down        |

The kitty surface (`src/tui/kitty.ts`) does not use OpenTUI's `ImageRenderable`, which clears the cells under an image
to the terminal's default background: with a translucent terminal, every late frame flashed a see-through square. It
reserves the cells with an empty box instead, so they keep the panel's background, and writes the kitty commands
through the renderer's output queue (`writeOut`, which OpenTUI uses for its own control sequences but does not type as
public).

Each frame is zlib-compressed RGBA, sent in chunks and placed at the slot's cell under the other of two alternating
image IDs; the previous image is deleted only after the new one is placed. (Retransmitting an ID would delete its
placements first, leaving the aura blank during a slow upload.) The cursor is saved and restored around each frame, all
inside one synchronized update, so it never visibly moves. Frames use the terminal's real cell size, capped at 65,000
pixels. The image is placed only once the slot's position has held for a frame, and deleted when the aura hides.
Without `writeOut`, the aura falls back to half-blocks.
