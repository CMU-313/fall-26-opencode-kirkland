import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useKV } from "../context/kv"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import {
  EDIT_APPROVAL_DEFAULT_KEY,
  editApprovalMode,
  editApprovalSession,
  parseEditApprovalMode,
  SIMPLE_EDIT_MAX_LINES,
  type EditApprovalMode,
} from "../util/edit-approval"

export function DialogPermissions(props: { sessionID?: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const kv = useKV()
  const dialog = useDialog()
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))

  const options = [
    {
      value: "always" as EditApprovalMode,
      title: "Always ask",
      description: "Review every code change before it is applied",
    },
    {
      value: "simple" as EditApprovalMode,
      title: "Simple changes only",
      description: `Auto-approve single-file edits of up to ${SIMPLE_EDIT_MAX_LINES} changed lines; ask for the rest`,
    },
    {
      value: "never" as EditApprovalMode,
      title: "Never ask",
      description: "Apply code changes without asking",
    },
  ]

  return (
    <DialogSelect<EditApprovalMode>
      title="Code change approval"
      options={options}
      current={editApprovalMode(session()) ?? parseEditApprovalMode(kv.get(EDIT_APPROVAL_DEFAULT_KEY))}
      flat={true}
      onSelect={(option) => {
        // The choice becomes the default for new sessions and also applies to the open session.
        kv.set(EDIT_APPROVAL_DEFAULT_KEY, option.value)
        if (props.sessionID) {
          void sdk.client.session.update({
            sessionID: props.sessionID,
            ...editApprovalSession(option.value, session()?.metadata),
          })
        }
        dialog.clear()
      }}
    />
  )
}
