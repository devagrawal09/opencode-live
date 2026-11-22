import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/** The server part's plugin id, which the desktop app gives the GUI too; Ipc ids must start with it. */
export const PLUGIN_ID = "opencode-gpt-live"

/**
 * Bridge from a window to the plugin's Electron main process, for the few things a window cannot do itself:
 * asking macOS for microphone access, keeping a window with a live call from being throttled in the background,
 * and ending the call if the window closes before it could.
 */
export const Host = Ipc.define({
  id: `${PLUGIN_ID}.host`,
  methods: {
    /** Asks the operating system for microphone access; true when granted. */
    microphone: { output: Schema.Boolean },
    /** Reports the window's call, or no call. */
    call: {
      input: Schema.Struct({
        active: Schema.Boolean,
        callID: Schema.optional(Schema.String),
        directory: Schema.optional(Schema.String),
        /** Whether the call runs on the desktop app's own server, which main can reach. */
        sidecar: Schema.optional(Schema.Boolean),
      }),
    },
  },
})
