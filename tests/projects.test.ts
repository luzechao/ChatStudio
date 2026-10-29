import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Projects } from "../src/main/projects.js";

test("projects isolate persistent conversations and enumerate files without following symlinks", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "chatstudio-projects-")));
  const privateRoot = path.join(base, "private");
  const a = path.join(base, "Project A");
  const b = path.join(base, "Project B");
  try {
    for (const dir of [privateRoot, path.join(a, "inputs"), b]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(a, "inputs/model.osm"), "model");
    await writeFile(path.join(a, ".env"), "hidden");
    if (process.platform !== "win32") await symlink(privateRoot, path.join(a, "private-link"));
    const projects = new Projects(privateRoot);
    await projects.load(a);
    await projects.append({ role: "user", text: "Summarize my building" });
    await projects.append({ role: "assistant", text: "## Building\nFour spaces." });
    const first = await projects.state();
    assert.deepEqual(first.files, [{ path: path.join("inputs", "model.osm"), size: 5 }]);
    assert.equal(first.conversations[0].messages.length, 2);
    const copy = await projects.state(); copy.conversations[0].messages[0].text = "modified";
    assert.equal((await projects.state()).conversations[0].messages[0].text, "Summarize my building");
    projects.newConversation();
    await projects.append({ role: "user", text: "Another question" });
    assert.equal((await projects.state()).conversations.length, 2);
    assert.equal((await projects.load(b)).conversations.length, 0);
    await projects.append({ role: "user", text: "Project B question" });
    await assert.rejects(projects.load(a, async () => { throw new Error("Engine unavailable"); }), /Engine unavailable/);
    assert.equal(projects.workspace, b, "Failed activation must retain the previous project");
    const restored = await new Projects(privateRoot).load(a);
    assert.equal(restored.conversations.length, 2);
    assert.ok(!JSON.stringify(restored).includes("Project B question"));
    assert.equal((await projects.recent()).length, 2);
    await assert.rejects(projects.load(privateRoot), /separate/);
    await assert.rejects(projects.load(base), /separate/);
    const registry = path.join(privateRoot, "projects.json");
    if (process.platform !== "win32") assert.equal((await lstat(registry)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(registry, "utf8")).includes("messages"));
    await writeFile(registry, "{}");
    await assert.rejects(projects.recent(), /Invalid/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("project file listing marks file/depth limits and rejects malformed histories", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "chatstudio-project-limits-")));
  const privateRoot = path.join(base, "private");
  const workspace = path.join(base, "project");
  try {
    await mkdir(privateRoot);
    await mkdir(workspace);
    await Promise.all(Array.from({ length: 401 }, (_, i) => writeFile(path.join(workspace, `${i}.osm`), "")));
    const projects = new Projects(privateRoot);
    const state = await projects.load(workspace);
    assert.equal(state.files.length, 400);
    assert.equal(state.truncated, true);
    await projects.append({ role: "user", text: "Question" });
    const [history] = await readdir(path.join(privateRoot, "conversations"));
    await writeFile(path.join(privateRoot, "conversations", history), '[{"messages":[]} ]');
    await assert.rejects(new Projects(privateRoot).load(workspace), /Invalid saved conversation/);
    await writeFile(path.join(privateRoot, "conversations", history), "[]");
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, "a/b/c/d/e/f"), { recursive: true });
    const limited = await new Projects(privateRoot).load(path.join(workspace, "a"));
    assert.equal(limited.truncated, false);
    await writeFile(path.join(workspace, "a/b/c/d/e/f/model.osm"), "");
    assert.equal((await new Projects(privateRoot).load(workspace)).truncated, true);
  } finally { await rm(base, { recursive: true, force: true }); }
});
