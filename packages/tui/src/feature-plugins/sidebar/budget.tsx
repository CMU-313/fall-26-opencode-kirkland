import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-budget"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const budget = createMemo(() => props.api.state.config.budget)
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  const used = createMemo(() => {
    const tokens = session()?.tokens
    return {
      cost: session()?.cost ?? 0,
      tokens: tokens
        ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
        : 0,
    }
  })

  const rows = createMemo(() => {
    const cfg = budget()
    if (!cfg) return []
    const out: { label: string; percent: number }[] = []
    if (cfg.cost !== undefined) {
      out.push({
        label: `${money.format(used().cost)} of ${money.format(cfg.cost)}`,
        percent: cfg.cost > 0 ? Math.round((used().cost / cfg.cost) * 100) : 100,
      })
    }
    if (cfg.tokens !== undefined) {
      out.push({
        label: `${used().tokens.toLocaleString()} of ${cfg.tokens.toLocaleString()} tokens`,
        percent: cfg.tokens > 0 ? Math.round((used().tokens / cfg.tokens) * 100) : 100,
      })
    }
    return out
  })

  const color = (percent: number) => {
    if (percent >= 100) return theme().error
    if (percent >= 80) return theme().warning
    return theme().textMuted
  }

  return (
    <Show when={rows().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Budget</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <>
              <text fg={theme().textMuted}>{row.label}</text>
              <text fg={color(row.percent)}>{row.percent}% used</text>
            </>
          )}
        </For>
        <text fg={theme().textMuted}>
          {budget()?.action === "ask" ? "asks before exceeding" : "stops at limit"}
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
