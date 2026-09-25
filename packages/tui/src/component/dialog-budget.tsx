import { createMemo } from "solid-js"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"

// Accepts "500000", "500k", "1.5m". Returns undefined when unparseable.
export function parseTokens(input: string) {
  const text = input.trim().toLowerCase().replace(/[,_ ]/g, "")
  if (!text) return undefined
  const match = text.match(/^(\d+(?:\.\d+)?)([km])?$/)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1
  return Math.round(value * scale)
}

export function DialogBudget() {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const current = createMemo(() => sync.data.config.budget?.tokens)

  return (
    <DialogPrompt
      title="Token budget for this session"
      placeholder="e.g. 500000 or 500k"
      value={current() !== undefined ? String(current()) : ""}
      onConfirm={(value) => {
        const tokens = parseTokens(value)
        if (tokens === undefined) return
        void sdk.client.config.update({
          config: { budget: { ...sync.data.config.budget, tokens, action: sync.data.config.budget?.action ?? "ask" } },
        })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
