import type { PermissionRuleset, Session } from "@opencode-ai/sdk/v2"
import { getRevertDiffFiles } from "./revert-diff"

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
