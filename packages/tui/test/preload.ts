import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(os.tmpdir(), "opencode-tui-xdg-"))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
mkdirSync(path.join(root, "config", "opencode"), { recursive: true })
mkdirSync(path.join(root, "data", "opencode"), { recursive: true })
mkdirSync(path.join(root, "state", "opencode"), { recursive: true })
mkdirSync(path.join(root, "cache", "opencode"), { recursive: true })
writeFileSync(path.join(root, "state", "opencode", "kv.json"), "{}")
