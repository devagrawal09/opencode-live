// OpenCode Desktop entry (./gui-experimental). `vite build` bundles it into dist/gui-experimental.cjs, which runs
// in every app window (setup) and in Electron's main process (main).
import { Plugin } from "@opencode/plugin/gui"

import { definition } from "./src/gui/definition"
import { main } from "./src/gui/main"
import { setup } from "./src/gui/window"

export default Plugin.define({ ...definition, setup, main })
