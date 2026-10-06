import type { PermissionRuleset, Session } from "@opencode-ai/sdk/v2"
import { getRevertDiffFiles } from "./revert-diff"
import { isRecord } from "./record"

export type EditApprovalMode = "always" | "simple" | "never"

export const SIMPLE_EDIT_MAX_LINES = 10

// KV key for the mode applied to newly created sessions.
export const EDIT_APPROVAL_DEFAULT_KEY = "edit_approval_default"

export function parseEditApprovalMode(value: unknown): EditApprovalMode | undefined {
  if (value === "always" || value === "simple" || value === "never") return value
  return undefined
}

// The mode is stored in session metadata so the TUI can tell "simple" apart from "always";
// the matching session permission rule is what makes the server ask or allow.
export function editApprovalMode(session: Session | undefined) {
  return parseEditApprovalMode(session?.metadata?.edit_approval)
}

// Subagent sessions inherit the mode of the session that spawned them.
export function resolveEditApprovalMode(
  sessionID: string,
  get: (sessionID: string) => Session | undefined,
): EditApprovalMode | undefined {
  const session = get(sessionID)
  const mode = editApprovalMode(session)
  if (mode || !session?.parentID) return mode
  return resolveEditApprovalMode(session.parentID, get)
}

// The server records the user's decision on the tool part's metadata.approval.
export function approvalBadge(metadata: unknown) {
  const approval = isRecord(metadata) ? metadata.approval : undefined
  if (!isRecord(approval)) return undefined
  if (approval.decision === "approved") {
    return { text: approval.reply === "always" ? "✓ approved (always)" : "✓ approved", tone: "success" as const }
  }
  if (approval.decision === "auto") return { text: "auto-approved", tone: "muted" as const }
  if (approval.decision === "rejected") {
    const feedback = typeof approval.feedback === "string" && approval.feedback ? approval.feedback : undefined
    return { text: feedback ? `✗ rejected: ${feedback}` : "✗ rejected", tone: "error" as const }
  }
  return undefined
}

// Session fields that apply a mode. Session rules are appended after agent rules, so this rule wins.
export function editApprovalSession(mode: EditApprovalMode, metadata?: Record<string, unknown>) {
  const permission: PermissionRuleset = [{ permission: "edit", pattern: "*", action: mode === "never" ? "allow" : "ask" }]
  const next: Record<string, unknown> = { ...metadata, edit_approval: mode }
  return { metadata: next, permission }
}

// A simple edit changes one existing file by at most SIMPLE_EDIT_MAX_LINES lines.
// New files ("@@ -0,0" hunks) always need review.
export function isSimpleEdit(diff: unknown) {
  if (typeof diff !== "string") return false
  const files = getRevertDiffFiles(diff)
  if (files.length !== 1) return false
  if (/^@@ -0,0 /m.test(diff)) return false
  return files[0].additions + files[0].deletions <= SIMPLE_EDIT_MAX_LINES
}
