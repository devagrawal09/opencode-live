import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/** The server part's plugin id, which the desktop app gives the GUI too; Ipc ids must start with it. */
export const PLUGIN_ID = "opencode-gpt-live"

/** Which window listens for the wake word, as each window sees it: none, this one, or another. */
export const WakeHolder = Schema.Literals(["free", "mine", "other"])

/**
 * Bridge from a window to the plugin's Electron main process, for the few things a window cannot do itself:
 * asking macOS for microphone access, keeping a window with a live call or a wake word listener from being throttled
 * in the background, ending the call if the window closes before it could, and fetching the wake word's files.
 */
export const Host = Ipc.define({
  id: `${PLUGIN_ID}.host`,
  state: Schema.Struct({ wake: WakeHolder }),
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
    /**
     * Claims or releases listening for the wake word: one window listens at a time. A claim while another window
     * listens is ignored unless `take` moves it here.
     */
    listen: {
      input: Schema.Struct({ active: Schema.Boolean, take: Schema.optional(Schema.Boolean) }),
    },
    /** The wake word model and ONNX Runtime's WebAssembly, base64: downloaded once, checked and cached. */
    wakeAssets: { output: Schema.Struct({ model: Schema.String, runtime: Schema.String }) },
  },
})
