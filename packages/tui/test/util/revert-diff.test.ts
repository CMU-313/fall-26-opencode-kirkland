import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import { getRevertDiffFiles } from "../../src/util/revert-diff"

describe("revert diff", () => {
  test("prefers the actual file path over /dev/null for added and deleted files", () => {
    const files = getRevertDiffFiles(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new content
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old content
`)

    expect(files).toEqual([
      {
        filename: "new.txt",
        additions: 1,
        deletions: 0,
      },
      {
        filename: "old.txt",
        additions: 0,
        deletions: 1,
      },
    ])
  })

  test("counts changes in edit permission diffs", () => {
    const files = getRevertDiffFiles(
      createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "let x = 1\nkeep\n", "const x = 1\nkeep\nextra\n"),
    )

    expect(files).toEqual([{ filename: "/repo/a.ts", additions: 2, deletions: 1 }])
  })

  test("counts each file in multi-file patch permission diffs", () => {
    const files = getRevertDiffFiles(
      [
        createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "one\n", "two\n"),
        createTwoFilesPatch("/repo/b.ts", "/repo/b.ts", "", "new\nfile\n"),
      ].join("\n"),
    )

    expect(files).toEqual([
      { filename: "/repo/a.ts", additions: 1, deletions: 1 },
      { filename: "/repo/b.ts", additions: 2, deletions: 0 },
    ])
  })

  test("returns no files for an empty diff", () => {
    expect(getRevertDiffFiles("")).toEqual([])
  })
})
