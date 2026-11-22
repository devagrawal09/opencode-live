import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Style,
  usePlugin,
  type MountedSession,
  type PanelTab,
  type Plugin,
} from "@opencode/plugin/gui"
import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js"

import { VOICES, type Voice } from "../shared/rpc"
import { createCall, type Call, type CallModel, type Target } from "./call"
import { Host } from "./contract"
import type { definition } from "./definition"
import type { Entry } from "./entries"

import css from "./panel.css?inline"

type Ctx = Parameters<Plugin.Setup<typeof definition>>[0]

const TAB = "call"
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
  const options = ctx.options as { voice?: string }
  const call = createCall({
    client: (server) => ctx.servers.get(server)?.client ?? ctx.client,
    host: ctx.main(Host),
    toast: (title, variant) => void ctx.toast.show({ title, variant, duration: variant === "error" ? 8000 : 4000 }),
    voice: VOICES.includes(options.voice as Voice) ? (options.voice as Voice) : undefined,
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
    void call.start(targetOf(session), { fresh, model: modelOf() })
  }

  const toggle = () => {
    if (call.active()) void call.stop()
    else start(ctx.sessions.current())
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
    width: "narrow",
    list: (input) => (input.open.includes(TAB) ? [tab] : []),
    render: (props) => <CallPanel call={call} session={props.session} now={now} start={start} />,
  })

  ctx.add(ComposerPill, {
    id: "call",
    show: (input) => {
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
  }
}

function CallPanel(props: {
  call: Call
  session: MountedSession
  now: () => number
  start(session: MountedSession, fresh?: boolean): void
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
    return ctx.t(`state.${state.phase}`)
  }

  let list: HTMLDivElement | undefined
  createEffect(() => {
    call.entries()
    if (list) list.scrollTop = list.scrollHeight
  })

  const goToCall = () => {
    const target = state.target
    if (target) ctx.tabs.open({ server: target.server, id: target.sessionID }, { focus: true })
  }

  return (
    <div class="gptlive-panel">
      <div class="gptlive-header">
        <span class="gptlive-dot" data-phase={state.phase} data-muted={state.muted ? "" : undefined} />
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
      </div>

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

      <div class="gptlive-entries" ref={(element) => (list = element)}>
        <Show when={call.entries().length > 0} fallback={<div class="gptlive-empty">{ctx.t("empty")}</div>}>
          <For each={call.entries()}>{(entry) => <Row entry={entry} />}</For>
        </Show>
      </div>
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
