import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  SettingsPage,
  Style,
  usePlugin,
  type MountedSession,
  type PanelTab,
  type Plugin,
} from "@opencode/plugin/gui"
import { For, Match, Show, Switch, createEffect, createSignal, untrack } from "solid-js"

import { PACES, VOICES, isPace, isVoice, type Pace, type Voice } from "../shared/rpc"
import { createCall, type Call, type CallModel, type Target } from "./call"
import { Host } from "./contract"
import type { definition } from "./definition"
import type { Entry } from "./entries"
import { countsOf } from "./events"
import { inSeconds, phaseOf, timingLine, toolDuration, totalOf, type Handoff } from "./handoffs"
import { IDLE_AFTER } from "./idle"
import { atBottom } from "./scroll"
import { WAKE_PHRASE, createWake, type Wake } from "./wake"

import css from "./panel.css?inline"

type Ctx = Parameters<Plugin.Setup<typeof definition>>[0]

const TAB = "call"
/** The voice agent's activity: what it did with each hand-off. */
/** The app's audio icon; SDK 2.3.0 has no plugin-declared icons yet. */
const ICON = "outline-audio"

function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

const targetOf = (session: MountedSession): Target => ({
  server: session.server.id,
  sessionID: session.id,
  directory: session.directory,
})

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const options = ctx.options as { voice?: string; pace?: string }
  const configuredVoice = isVoice(options.voice) ? options.voice : undefined
  const configuredPace = isPace(options.pace) ? options.pace : undefined
  // The settings page's choices win over the plugin options; the server applies them when a call starts.
  const chosenVoice = (): Voice | undefined => {
    const voice = ctx.stores.prefs.value.voice
    return isVoice(voice) ? voice : configuredVoice
  }
  const chosenPace = (): Pace | undefined => ctx.stores.prefs.value.pace ?? configuredPace
  const host = ctx.main(Host)
  const toast = (title: string, variant: "default" | "error") =>
    void ctx.toast.show({ title, variant, duration: variant === "error" ? 8000 : 4000 })
  const wake = createWake({
    assets: () => host.wakeAssets(),
    microphone: () => host.microphone().catch(() => true),
    busy: () => call.active(),
    wake: () => onWake(),
    error: (message) => toast(message, "error"),
  })
  const call = createCall({
    client: (server) => ctx.servers.get(server)?.client ?? ctx.client,
    host,
    toast,
    voice: configuredVoice,
    debug: () => ctx.stores.prefs.value.debugEvents,
    wake: {
      listening: () => wake.status() === "listening" || wake.status() === "loading",
      stream: () => wake.stream(),
      pause: () => void wake.pause(),
      resume: () => void wake.resume(),
    },
  })

  // A clock for the elapsed time, ticking only while a call is up.
  const [now, setNow] = createSignal(Date.now())
  let clock: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    clearInterval(clock)
    clock = undefined
    if (call.state.phase === "live") clock = setInterval(() => setNow(Date.now()), 1000)
  })

  const key = `${ctx.id}:${TAB}`
  const tab: PanelTab = {
    id: TAB,
    get title() {
      return ctx.t("panel.title")
    },
    closable: "hover",
  }

  const modelOf = (): CallModel | undefined => {
    const model = ctx.screen.current()?.composer.model()
    return model ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant } : undefined
  }

  const openPanel = (session: MountedSession) => ctx.layout.open(key, session, { tab: "select", background: true })

  const start = (session: MountedSession | undefined, fresh = false) => {
    if (!session) {
      ctx.toast.show({ title: ctx.t("no.session") })
      return
    }
    openPanel(session)
    void call.start(targetOf(session), { fresh, model: modelOf(), voice: chosenVoice(), pace: chosenPace() })
  }

  const toggle = () => {
    if (call.active()) void call.stop()
    else start(ctx.sessions.current())
  }

  // The wake word: the setting is shared by every window, and main lets one of them listen at a time.
  const wakeOn = () => ctx.stores.prefs.value.wakeWord === true
  createEffect(() => {
    const on = wakeOn()
    const holder = host.state()?.wake
    // Only the setting and the holder drive this: a failed arm must not retry each time the listener's status changes.
    untrack(() => {
      if (!on) {
        void wake.disarm()
        if (holder === "mine") void host.listen({ active: false }).catch(() => undefined)
      } else if (holder === "free") void host.listen({ active: true }).catch(() => undefined)
      else if (holder === "mine") void wake.arm()
      else if (holder === "other") void wake.disarm()
    })
  })

  const toggleWake = async () => {
    const on = !wakeOn()
    await ctx.stores.prefs.update((draft) => {
      draft.wakeWord = on
    })
    // Turned on here, it listens here, even if another window was.
    if (on) await host.listen({ active: true, take: true }).catch(() => undefined)
  }

  /** The wake word was heard: a call about this window's session, which hangs up once it goes quiet. */
  function onWake() {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.toast.show({ title: ctx.t("no.session") })
      void wake.resume()
      return
    }
    openPanel(session)
    void call.start(targetOf(session), { model: modelOf(), voice: chosenVoice(), pace: chosenPace(), wake: true })
  }

  ctx.add(Style, css)

  ctx.add(Command, (): Command => ({
    id: "toggle",
    title: ctx.t(call.active() ? "command.end" : "command.start"),
    group: ctx.t("command.group"),
    keywords: "voice call gpt live talk speak microphone",
    section: "session",
    bind: "mod+alt+v",
    slash: { name: "voice" },
    enabled: call.active() || !!ctx.sessions.current(),
    run: toggle,
  }))

  ctx.add(Command, (): Command => ({
    id: "mute",
    title: ctx.t(call.state.muted ? "command.unmute" : "command.mute"),
    group: ctx.t("command.group"),
    keywords: "voice mute microphone",
    section: "session",
    bind: "mod+alt+m",
    enabled: call.active(),
    run: () => call.toggleMute(),
  }))

  ctx.add(Command, (): Command => ({
    id: "new",
    title: ctx.t("command.new"),
    group: ctx.t("command.group"),
    keywords: "voice call fresh new conversation",
    section: "session",
    slash: { name: "voice-new" },
    enabled: !!ctx.sessions.current(),
    run: async () => {
      const session = ctx.sessions.current()
      if (call.active()) await call.stop()
      start(session, true)
    },
  }))

  ctx.add(Command, (): Command => ({
    id: "wake",
    title: ctx.t(wakeOn() ? "command.wake.stop" : "command.wake.start"),
    group: ctx.t("command.group"),
    keywords: "voice wake word hey jarvis listen hands free microphone",
    section: "session",
    run: () => void toggleWake(),
  }))

  ctx.add(Command, (): Command => ({
    id: "events",
    title: ctx.t(ctx.stores.prefs.value.debugEvents ? "command.events.hide" : "command.events.show"),
    group: ctx.t("command.group"),
    keywords: "voice debug events gpt live trace",
    section: "session",
    run: () =>
      void ctx.stores.prefs.update((draft) => {
        draft.debugEvents = !draft.debugEvents
      }),
  }))

  ctx.add(Command, (): Command => ({
    id: "panel",
    title: ctx.t("command.panel"),
    group: ctx.t("command.group"),
    keywords: "voice call transcript panel",
    section: "session",
    enabled: !!ctx.sessions.current(),
    run: () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(key, session)
    },
  }))

  ctx.add(Command, (): Command => ({
    id: "pick",
    title: ctx.t("command.pick"),
    group: ctx.t("command.group"),
    keywords: "voice pick choose pace speed slower faster gpt live settings",
    section: "session",
    slash: { name: "voice-pick" },
    run: () => ctx.layout.settings(ctx.id),
  }))

  const settingIDs = { voice: `${ctx.id}-voice`, pace: `${ctx.id}-pace` }
  ctx.add(SettingsPage, {
    id: ctx.id,
    icon: ICON,
    get title() {
      return ctx.t("settings.title")
    },
    get entries() {
      return [
        { id: ctx.id, title: ctx.t("settings.title"), keywords: "gpt live voice call" },
        {
          id: settingIDs.voice,
          title: ctx.t("settings.voice"),
          description: ctx.t("settings.voice.description"),
          keywords: "gpt live voice speaker sound",
        },
        {
          id: settingIDs.pace,
          title: ctx.t("settings.pace"),
          description: ctx.t("settings.pace.description"),
          keywords: "gpt live pace speed slow slower fast faster",
        },
      ]
    },
    render: () => (
      <VoiceSettings
        call={call}
        ids={settingIDs}
        voice={() => chosenVoice() ?? "cove"}
        pace={() => chosenPace() ?? "normal"}
      />
    ),
  })

  ctx.add(MenuItem, (): MenuItem => {
    const session = ctx.sessions.current()
    return {
      menu: "session.panel",
      id: "call",
      title: ctx.t("menu.panel"),
      icon: ICON,
      keybind: `${ctx.id}.toggle`,
      opened: !!session && ctx.layout.state(key, session) !== "closed",
      run: () => {
        if (session) ctx.layout.open(key, session)
      },
    }
  })

  ctx.add(Panel, {
    id: TAB,
    region: "side",
    list: (input) => (input.open.includes(TAB) ? [tab] : []),
    render: (props) => (
      <CallPanel
        call={call}
        wake={wake}
        wakeOn={wakeOn}
        toggleWake={() => void toggleWake()}
        session={props.session}
        now={now}
        start={start}
        voice={() => chosenVoice() ?? "cove"}
        pace={() => chosenPace() ?? "normal"}
      />
    ),
  })

  ctx.add(ComposerPill, {
    id: "call",
    show: (input) => {
      if (call.listening())
        return {
          label: ctx.t("pill.listening"),
          title: ctx.t("state.listening", { phrase: WAKE_PHRASE }),
          icon: ICON,
          rows: [
            { id: "panel", label: ctx.t("pill.panel"), icon: "layout-right", run: () => openPanel(input.session) },
            { id: "wake", label: ctx.t("wake.stop"), icon: "stop", run: () => void toggleWake() },
          ],
        }
      if (!call.owns(input.session.id)) return undefined
      const { phase, muted, liveAt } = call.state
      const label =
        phase === "connecting"
          ? ctx.t("state.connecting")
          : phase === "closing"
            ? ctx.t("state.closing")
            : `${ctx.t(muted ? "state.muted" : "state.live")} · ${elapsed(liveAt, now())}`
      return {
        label,
        title: ctx.t("title"),
        icon: ICON,
        tone: phase === "live" ? (muted ? "warning" : "success") : undefined,
        rows: [
          {
            id: "mute",
            label: ctx.t(muted ? "unmute" : "mute"),
            icon: ICON,
            run: () => call.toggleMute(),
          },
          { id: "panel", label: ctx.t("pill.panel"), icon: "layout-right", run: () => openPanel(input.session) },
          { id: "end", label: ctx.t("end"), icon: "stop", tone: "danger", run: () => void call.stop() },
        ],
      }
    },
  })

  return () => {
    clearInterval(clock)
    void call.dispose()
    void wake.disarm()
    void host.listen({ active: false }).catch(() => undefined)
  }
}

/** The settings page: GPT-Live's voice and a speaking-pace hint, both read when the next call starts. */
/** Saves the voice and pace the next call uses; the settings page and the call panel share them. */
function setVoice(ctx: Ctx, voice: Voice) {
  void ctx.stores.prefs.update((draft) => {
    draft.voice = voice
  })
}

function setPace(ctx: Ctx, pace: Pace) {
  void ctx.stores.prefs.update((draft) => {
    draft.pace = pace
  })
}

function VoiceSettings(props: { call: Call; ids: { voice: string; pace: string }; voice(): Voice; pace(): Pace }) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const ui = ctx.ui
  return (
    <ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
      <ui.SettingsSection
        title={ctx.t("settings.section")}
        footer={
          <Show when={props.call.active()}>
            <div class="gptlive-meta">{ctx.t("settings.active")}</div>
          </Show>
        }
      >
        <ui.SettingsRow
          id={props.ids.voice}
          title={ctx.t("settings.voice")}
          description={ctx.t("settings.voice.description")}
        >
          <ui.Select
            label={ctx.t("settings.voice")}
            options={VOICES.map((voice) => ({ value: voice, label: voice }))}
            value={props.voice()}
            onChange={(voice: Voice) => setVoice(ctx, voice)}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id={props.ids.pace}
          title={ctx.t("settings.pace")}
          description={ctx.t("settings.pace.description")}
        >
          <ui.Select
            label={ctx.t("settings.pace")}
            options={PACES.map((pace) => ({ value: pace, label: ctx.t(`settings.pace.${pace}`) }))}
            value={props.pace()}
            onChange={(pace: Pace) => setPace(ctx, pace)}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}

function CallPanel(props: {
  call: Call
  wake: Wake
  wakeOn(): boolean
  toggleWake(): void
  session: MountedSession
  now: () => number
  start(session: MountedSession, fresh?: boolean): void
  voice(): Voice
  pace(): Pace
}) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const ui = ctx.ui
  const call = props.call
  const state = call.state
  const busy = () => state.phase === "connecting" || state.phase === "closing"
  const elsewhere = () => call.active() && !call.owns(props.session.id)

  const status = () => {
    if (state.phase === "live")
      return `${ctx.t(state.muted ? "state.muted" : "state.live")} · ${elapsed(state.liveAt, props.now())}`
    if (state.phase === "idle" && props.wake.status() === "loading") return ctx.t("state.wake.loading")
    if (call.listening()) return ctx.t("state.listening", { phrase: WAKE_PHRASE })
    return ctx.t(`state.${state.phase}`)
  }
  const wakeNote = () => {
    if (!props.wakeOn()) return undefined
    const wakeStatus = props.wake.status()
    if (wakeStatus === "error") return props.wake.error()
    if (wakeStatus === "paused") return ctx.t("wake.paused")
    if (wakeStatus === "off") return ctx.t("wake.other")
    return ctx.t("wake.note", { phrase: WAKE_PHRASE, seconds: Math.round(IDLE_AFTER / 1000) })
  }

  // Follow new transcript text only while the list is at its end; once the user scrolls up, leave it there until
  // they scroll back down or a new call starts.
  let list: HTMLDivElement | undefined
  let follow = true
  const onScroll = () => {
    if (list) follow = atBottom(list)
  }
  createEffect(() => {
    if (state.phase === "connecting") follow = true
  })
  createEffect(() => {
    call.entries()
    if (list && follow) list.scrollTop = list.scrollHeight
  })

  const goToCall = () => {
    const target = state.target
    if (target) ctx.tabs.open({ server: target.server, id: target.sessionID }, { focus: true })
  }

  return (
    <div class="gptlive-panel">
      <div class="gptlive-header">
        <span
          class="gptlive-dot"
          data-phase={call.listening() ? "listening" : state.phase}
          data-muted={state.muted ? "" : undefined}
        />
        <span class="gptlive-status">{status()}</span>
        <Show when={state.voice}>{(voice) => <span class="gptlive-meta">{voice()}</span>}</Show>
      </div>

      <div class="gptlive-actions">
        <Show
          when={call.active()}
          fallback={
            <>
              <ui.Button variant="contrast" size="small" icon={ICON} onClick={() => props.start(props.session)}>
                {ctx.t("start")}
              </ui.Button>
              <ui.Button variant="ghost" size="small" onClick={() => props.start(props.session, true)}>
                {ctx.t("fresh")}
              </ui.Button>
            </>
          }
        >
          <ui.Button
            variant="neutral"
            size="small"
            icon={ICON}
            disabled={state.phase !== "live"}
            onClick={() => call.toggleMute()}
          >
            {ctx.t(state.muted ? "unmute" : "mute")}
          </ui.Button>
          <ui.Button variant="danger" size="small" icon="stop" busy={busy()} onClick={() => void call.stop()}>
            {ctx.t("end")}
          </ui.Button>
        </Show>
        <ui.Button variant="ghost" size="small" onClick={() => props.toggleWake()}>
          {props.wakeOn() ? ctx.t("wake.stop") : ctx.t("wake.start", { phrase: WAKE_PHRASE })}
        </ui.Button>
      </div>

      <Show when={wakeNote()}>
        {(note) => (
          <div class="gptlive-note" data-wake={props.wake.status()}>
            {note()}
          </div>
        )}
      </Show>

      {/* Voice and pace are fixed when a call starts, so they are only offered between calls. */}
      <Show when={!call.active()}>
        <div class="gptlive-choices">
          <ui.Select
            label={ctx.t("settings.voice")}
            options={VOICES.map((voice) => ({ value: voice, label: voice }))}
            value={props.voice()}
            onChange={(voice: Voice) => setVoice(ctx, voice)}
          />
          <ui.Select
            label={ctx.t("settings.pace")}
            options={PACES.map((pace) => ({ value: pace, label: ctx.t(`settings.pace.${pace}`) }))}
            value={props.pace()}
            onChange={(pace: Pace) => setPace(ctx, pace)}
          />
        </div>
      </Show>

      <Show when={elsewhere()}>
        <div class="gptlive-note">
          {ctx.t("other.session")}{" "}
          <button type="button" class="gptlive-link" onClick={goToCall}>
            {ctx.t("other.go")}
          </button>
        </div>
      </Show>

      <Show when={call.active()}>
        <div class="gptlive-levels">
          <Level label={ctx.t("level.mic")} value={state.muted ? 0 : call.levels().mic} kind="mic" />
          <Level label={ctx.t("level.speaker")} value={call.levels().speaker} kind="speaker" />
        </div>
        <Show when={state.voiceActivity || state.mainActivity || state.queued}>
          <div class="gptlive-activity">
            <Show when={state.voiceActivity}>
              {(label) => (
                <div>
                  <span class="gptlive-meta">{ctx.t("activity.voice")}:</span> {label()}
                </div>
              )}
            </Show>
            <Show when={state.mainActivity}>
              {(label) => (
                <div>
                  <span class="gptlive-meta">{ctx.t("activity.main")}:</span> {label()}
                </div>
              )}
            </Show>
            <Show when={state.queued}>
              <div class="gptlive-meta">{ctx.t("queued", { count: state.queued })}</div>
            </Show>
          </div>
        </Show>
      </Show>

      {/* Transcript and voice agent side by side; the voice agent collapses to a thin rail on the right. */}
      <div class="gptlive-body">
        <div class="gptlive-entries" ref={(element) => (list = element)} onScroll={onScroll}>
          <Show when={call.entries().length > 0} fallback={<div class="gptlive-empty">{ctx.t("empty")}</div>}>
            <For each={call.entries()}>{(entry) => <Row entry={entry} />}</For>
          </Show>
        </div>

        <VoiceAgentSection call={call} />
      </div>

      <Show when={ctx.stores.prefs.value.debugEvents}>
        <EventsView call={call} />
      </Show>
    </div>
  )
}

/** The optional debug view: GPT-Live's data-channel events for the current call, newest first, with counts. */
function EventsView(props: { call: Call }) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const rows = () => props.call.liveEvents().toReversed()
  const hide = () =>
    void ctx.stores.prefs.update((draft) => {
      draft.debugEvents = false
    })
  return (
    <div class="gptlive-events">
      <div class="gptlive-events-header">
        <span class="gptlive-speaker">{ctx.t("events.title")}</span>
        <button type="button" class="gptlive-link" onClick={hide}>
          {ctx.t("events.hide")}
        </button>
      </div>
      <Show when={props.call.eventCounts().size > 0}>
        <div class="gptlive-events-counts">
          {countsOf(props.call.eventCounts())
            .map(([type, count]) => `${type} ×${count}`)
            .join("  ")}
        </div>
      </Show>
      <div class="gptlive-events-list">
        <Show when={rows().length > 0} fallback={<div class="gptlive-meta">{ctx.t("events.empty")}</div>}>
          <For each={rows()}>
            {(row) => (
              <div class="gptlive-event">
                <span class="gptlive-meta">+{(row.at / 1000).toFixed(1)}s</span> <span>{row.type}</span>
                <Show when={row.detail}>
                  <span class="gptlive-meta"> {row.detail}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

/** The voice agent's tab: one card per hand-off, newest first, kept apart from the GPT-Live transcript. */
/**
 * The voice agent's hand-offs, beside the transcript in the same tab. Collapses to a thin rail; whether it is open is
 * saved, and it starts open.
 */
function VoiceAgentSection(props: { call: Call }) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const state = props.call.state
  // Keyed by id, so a card (and whether its details are open) survives its hand-off's updates.
  const ids = () =>
    props.call
      .handoffs()
      .map((handoff) => handoff.id)
      .toReversed()
  const byID = (id: string) => props.call.handoffs().find((handoff) => handoff.id === id)
  const openSession = () => {
    const target = state.target
    const id = state.voiceSessionID
    if (target && id) ctx.tabs.open({ server: target.server, id }, { focus: true })
  }
  const open = () => ctx.stores.prefs.value.voiceAgentOpen ?? true
  const toggle = () =>
    void ctx.stores.prefs.update((draft) => {
      draft.voiceAgentOpen = !open()
    })
  return (
    <div class="gptlive-agent" data-open={open() ? "" : undefined}>
      <div class="gptlive-agent-header">
        <button
          type="button"
          class="gptlive-agent-toggle"
          aria-expanded={open()}
          title={ctx.t("voice.title")}
          onClick={toggle}
        >
          <span class="gptlive-agent-chevron">{open() ? "▸" : "◂"}</span>
          <span class="gptlive-speaker">{ctx.t("voice.title")}</span>
          <Show when={ids().length > 0}>
            <span class="gptlive-meta">{ids().length}</span>
          </Show>
        </button>
        <Show when={open() && state.target && state.voiceSessionID}>
          <button type="button" class="gptlive-link gptlive-handoff-open" onClick={openSession}>
            {ctx.t("voice.open")}
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <div class="gptlive-agent-list gptlive-handoffs">
          <Show when={ids().length > 0} fallback={<div class="gptlive-empty">{ctx.t("voice.empty")}</div>}>
            <For each={ids()}>
              {(id) => <Show when={byID(id)}>{(handoff) => <HandoffCard handoff={handoff()} />}</Show>}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const usd = (value: number) => `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`

function HandoffCard(props: { handoff: Handoff }) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const handoff = () => props.handoff
  const phase = () => phaseOf(handoff())
  const timing = () =>
    timingLine(
      handoff(),
      (key) => ctx.t(`voice.time.${key}`),
      (channel) => ctx.t(`voice.channel.${channel}`),
    )
  return (
    <div class="gptlive-handoff" data-phase={phase()}>
      <div class="gptlive-handoff-head">
        <span class="gptlive-handoff-dot" data-phase={phase()} title={ctx.t(`voice.phase.${phase()}`)} />
        <span class="gptlive-handoff-request">{handoff().request ?? ctx.t("voice.unknown")}</span>
        <Show when={totalOf(handoff())}>{(total) => <span class="gptlive-meta">{inSeconds(total())}</span>}</Show>
      </div>
      <Show when={timing()}>
        <div class="gptlive-handoff-timing">{timing()}</div>
      </Show>
      <details class="gptlive-handoff-details">
        <summary>{ctx.t("voice.details")}</summary>
        <Show when={handoff().context}>
          {(context) => (
            <div class="gptlive-meta">
              {ctx.t("voice.context", {
                turns: context().turns,
                updates: context().updates,
                chars: context().chars,
              })}
              {context().first ? ` · ${ctx.t("voice.context.first")}` : ""}
            </div>
          )}
        </Show>
        <Show when={handoff().tools.length > 0}>
          <div class="gptlive-handoff-section">
            <span class="gptlive-speaker">{ctx.t("voice.tools")}</span>
            <For each={handoff().tools}>
              {(tool) => (
                <div class="gptlive-handoff-tool" data-status={tool.status}>
                  <div>
                    {tool.name}
                    <span class="gptlive-meta">
                      {" · "}
                      {toolDuration(tool) !== undefined
                        ? inSeconds(toolDuration(tool) ?? 0)
                        : ctx.t("voice.tool.running")}
                    </span>
                  </div>
                  <Show when={tool.args}>{(args) => <pre class="gptlive-handoff-code">{args()}</pre>}</Show>
                  <Show when={tool.result}>
                    {(result) => (
                      <pre class="gptlive-handoff-code" data-result="">
                        {result()}
                      </pre>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={handoff().reply}>
          {(reply) => (
            <div class="gptlive-handoff-section">
              <span class="gptlive-speaker">
                {ctx.t("voice.reply")}{" "}
                <span class="gptlive-handoff-badge" data-channel={reply().channel}>
                  {ctx.t(`voice.channel.${reply().channel}`)}
                </span>
              </span>
              <span class="gptlive-handoff-reply">{reply().text ?? ctx.t("voice.reply.none")}</span>
            </div>
          )}
        </Show>
        <Show when={handoff().tokens || handoff().cost !== undefined}>
          <div class="gptlive-meta">
            {[
              handoff().tokens
                ? ctx.t("voice.usage", { input: handoff().tokens?.input ?? 0, output: handoff().tokens?.output ?? 0 })
                : "",
              handoff().cost ? usd(handoff().cost ?? 0) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </Show>
      </details>
    </div>
  )
}

function Level(props: { label: string; value: number; kind: "mic" | "speaker" }) {
  return (
    <div class="gptlive-level">
      <span class="gptlive-meta">{props.label}</span>
      <div class="gptlive-bar" data-kind={props.kind}>
        <div style={{ transform: `scaleX(${props.value.toFixed(3)})` }} />
      </div>
    </div>
  )
}

function Row(props: { entry: Entry }) {
  const ctx = usePlugin<typeof definition>() as Ctx
  const as = <K extends Entry["kind"]>(...kinds: K[]) =>
    (kinds as string[]).includes(props.entry.kind) ? (props.entry as Extract<Entry, { kind: K }>) : undefined
  return (
    <Switch>
      <Match when={as("task")}>
        {(task) => (
          <div class="gptlive-task" data-status={task().status}>
            <span class="gptlive-badge">{ctx.t(`task.${task().status}`)}</span>
            <span class="gptlive-task-text">
              {task().text}
              <Show when={task().detail}>{(detail) => <span class="gptlive-meta"> — {detail()}</span>}</Show>
            </span>
          </div>
        )}
      </Match>
      <Match when={as("divider")}>
        {(divider) => (
          <div class="gptlive-divider" role="separator">
            <span>{divider().text}</span>
          </div>
        )}
      </Match>
      <Match when={as("notice")}>
        {(notice) => (
          <div class="gptlive-notice" data-tone={notice().tone}>
            {notice().text}
          </div>
        )}
      </Match>
      <Match when={as("user", "assistant")}>
        {(line) => (
          <div class="gptlive-line" data-role={line().kind} data-past={line().past ? "" : undefined}>
            <span class="gptlive-speaker">{ctx.t(line().kind === "user" ? "you" : "assistant")}</span>
            <span>{line().text}</span>
          </div>
        )}
      </Match>
    </Switch>
  )
}
