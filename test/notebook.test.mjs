import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginNotebook, addNotebookEntry, resolveNotebookPath } from "../src/notebook.mjs";

test("creates and extends a notebook", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-test-"));
  await beginNotebook(root, { path: "notes/session.md", title: "Vectors" });
  await addNotebookEntry(root, { path: "notes/session.md", kind: "insight", body: "Direction and magnitude belong together." });
  const text = await readFile(join(root, "notes/session.md"), "utf8");
  assert.match(text, /# Vectors/);
  assert.match(text, /KEY CONNECTION/);
});

test("writes summary, question, misconception, and source entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-test-"));
  await beginNotebook(root, { path: "notes.md", title: "Mixed" });
  await addNotebookEntry(root, { path: "notes.md", kind: "question", body: "Why does this follow?" });
  await addNotebookEntry(root, { path: "notes.md", kind: "misconception", body: "The side effect is not the mechanism." });
  await addNotebookEntry(root, { path: "notes.md", kind: "source", body: "Book, p. 42" });
  const text = await readFile(join(root, "notes.md"), "utf8");
  assert.match(text, /OPEN QUESTION/);
  assert.match(text, /\[!warning\] MISCONCEPTION/);
  assert.match(text, /SOURCE/);
});

test("rejects notebook paths outside the workspace", () => {
  assert.throws(() => resolveNotebookPath("/tmp/work", "../outside.md"), /inside the working directory/);
});
