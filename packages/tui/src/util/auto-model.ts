import type { Session } from "@opencode-ai/sdk/v2"

// KV key for the pending auto-model toggle before the first session is created.
export const AUTO_MODEL_KV_KEY = "pending_auto_model"

// Typed accessor for session.metadata.autoModel.
// Note: The SDK-generated Config and Session types do not yet include autoModel;
// Section 8 will regenerate the SDK to add the typed field.
function readAutoModelMeta(session: Session | undefined) {
  const raw = session?.metadata
  if (!raw || typeof raw !== "object") return { enabled: undefined, last: undefined }
  const autoModel = (raw as Record<string, unknown>).autoModel
  if (!autoModel || typeof autoModel !== "object") return { enabled: undefined, last: undefined }
  const a = autoModel as Record<string, unknown>
  const lastRaw = a.last
  const last =
    typeof lastRaw === "object" &&
    lastRaw !== null &&
    typeof (lastRaw as Record<string, unknown>).providerID === "string" &&
    typeof (lastRaw as Record<string, unknown>).modelID === "string"
      ? (lastRaw as { providerID: string; modelID: string })
      : undefined
  return {
    enabled: typeof a.enabled === "boolean" ? a.enabled : undefined,
    last,
  }
}

/**
 * Returns the last routed model from session metadata, if any.
 * Used to display "Auto model · <name>" in the prompt footer.
 */
export function getAutoModelLast(session: Session | undefined) {
  return readAutoModelMeta(session).last
}

/**
 * Computes the effective auto-model enabled flag:
 *   session.metadata.autoModel.enabled ?? config.autoModel.enabled ?? false
 *
 * When no session exists yet, uses the pending kv value as the override instead
 * of session metadata.
 *
 * Note: config is typed as unknown because the SDK-generated Config type does not
 * yet include autoModel; Section 8 will regenerate the SDK to add it.
 */
export function effectiveAutoEnabled(
  sessionID: string | undefined,
  session: Session | undefined,
  config: unknown,
  kvPending: boolean | undefined,
): boolean {
  // Read autoModel.enabled from config (untyped until SDK regen in Section 8).
  const configEnabled: boolean | undefined =
    config !== null &&
    typeof config === "object" &&
    typeof (config as Record<string, unknown>).autoModel === "object" &&
    (config as Record<string, unknown>).autoModel !== null &&
    typeof ((config as Record<string, unknown>).autoModel as Record<string, unknown>).enabled === "boolean"
      ? (((config as Record<string, unknown>).autoModel as Record<string, unknown>).enabled as boolean)
      : undefined

  if (sessionID !== undefined) {
    // Session exists: session metadata takes precedence over config.
    const { enabled } = readAutoModelMeta(session)
    return enabled ?? configEnabled ?? false
  }
  // No session yet: pending kv value takes precedence over config.
  return kvPending ?? configEnabled ?? false
}

/**
 * Builds merged session metadata for an autoModel enable/disable write.
 * Always merges on top of current metadata so no other keys are lost.
 * When resetState is true, clears hysteresis state and last (used when enabling).
 */
export function mergeAutoModelMetadata(
  currentMetadata: Record<string, unknown> | undefined,
  update: { enabled: boolean; resetState?: boolean },
): Record<string, unknown> {
  const base = currentMetadata ?? {}
  const existing =
    typeof base.autoModel === "object" && base.autoModel !== null
      ? (base.autoModel as Record<string, unknown>)
      : {}
  const next: Record<string, unknown> = { ...existing, enabled: update.enabled }
  if (update.resetState) {
    next.state = undefined
    next.last = undefined
  }
  return { ...base, autoModel: next }
}

/**
 * Shared helper: merges autoModel metadata and calls the session update function.
 * Used by the toggle command, dialog-model onSelect, and model cycle handlers so
 * all three call sites go through the same merge logic.
 */
export async function writeAutoModelToSession(
  sessionUpdateFn: (params: { sessionID: string; metadata: Record<string, unknown> }) => unknown,
  sessionID: string,
  currentMetadata: Record<string, unknown> | undefined,
  update: { enabled: boolean; resetState?: boolean },
): Promise<void> {
  const metadata = mergeAutoModelMetadata(currentMetadata, update)
  await sessionUpdateFn({ sessionID, metadata })
}
