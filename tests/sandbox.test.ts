import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { prepareSandbox } from "../src/main/sandbox.js";

test("private data protection refuses home directories and filesystem roots before changing permissions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "chatstudio-private-path-"));
  try {
    for (const privateRoot of [homedir(), path.dirname(homedir()), path.parse(workspace).root]) {
      await assert.rejects(prepareSandbox({
        workspace, backend: { command: process.execPath, args: [], readRoots: [], environment: {} },
      }, privateRoot), /private data must use a dedicated directory/);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("real OS sandbox blocks sibling/private reads, outside writes, child escape, network and inherited secrets", {
  skip: !["darwin", "linux", "win32"].includes(process.platform),
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(path.join(process.platform === "win32" ? process.cwd() : homedir(), ".chatstudio-test-"));
  const outsideRoot = await realpath(await mkdtemp(path.join(process.platform === "win32" ? homedir() : tmpdir(), "chatstudio-outside-")));
  const outsideFile = path.join(outsideRoot, "escape.txt");
  const workspace = path.join(base, "workspace");
  const privateRoot = path.join(base, "private");
  const secret = path.join(process.platform === "win32" ? outsideRoot : base, "secret.txt");
  const server = createServer((socket) => socket.end("unexpected"));
  process.env.CHATSTUDIO_TEST_SECRET = "must-not-inherit";
  try {
    await mkdir(workspace); await mkdir(privateRoot);
    await writeFile(secret, "synthetic-private-data");
    await writeFile(path.join(privateRoot, "secret.txt"), "synthetic-agent-data");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const script = path.join(workspace, "probe.mjs");
    const deniedCodes = process.platform === "linux" ? ["EPERM", "EACCES", "ENOENT", "EROFS"] : ["EPERM", "EACCES"];
    await writeFile(script, `
      import fs from 'node:fs';
      import net from 'node:net';
      import {spawnSync} from 'node:child_process';
      const deniedCodes = ${JSON.stringify(deniedCodes)};
      const blocked = (fn) => {try {fn();return false;}catch(e){if(!deniedCodes.includes(e.code))throw e;return true;}};
      const out = {};
      fs.writeFileSync(${JSON.stringify(path.join(workspace, "allowed.txt"))}, 'allowed');
      out.workspaceWrite = true;
      out.secretReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(secret)}));
      out.privateReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(path.join(privateRoot, "secret.txt"))}));
      out.newPrivateReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(path.join(privateRoot, "new-secret.txt"))}));
      out.newNestedPrivateReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(path.join(privateRoot, "new-directory", "secret.txt"))}));
      blocked(()=>fs.writeFileSync(${JSON.stringify(path.join(privateRoot, "secret.txt"))}, 'no'));
      out.outsideWriteDenied = blocked(()=>fs.writeFileSync(${JSON.stringify(outsideFile)}, 'no'));
      out.environmentScrubbed = !process.env.CHATSTUDIO_TEST_SECRET;
      const child=spawnSync(process.execPath,['-e',${JSON.stringify(`try {require('fs').readFileSync(${JSON.stringify(secret)});process.exit(1)}catch(e){process.exit(${JSON.stringify(deniedCodes)}.includes(e.code)?0:2)}`)}],{encoding:'utf8'});
      out.childReadDenied = child.status === 0;
      out.networkDenied = await new Promise(resolve=>{
        const socket=net.connect(${address.port},'127.0.0.1');
        socket.on('connect',()=>{socket.destroy();resolve(false)});
        socket.on('error',()=>resolve(true));
        socket.setTimeout(1500,()=>{socket.destroy();resolve(false)});
      });

      console.log(JSON.stringify(out));
    `);
    const { warnings: _warnings, ...launch } = await prepareSandbox({
      workspace, backend: { command: process.execPath, args: ["--preserve-symlinks-main", script], readRoots: [], environment: {} },
    }, privateRoot);
    await writeFile(path.join(privateRoot, "new-secret.txt"), "created-after-sandbox-initialization");
    await mkdir(path.join(privateRoot, "new-directory"));
    await writeFile(path.join(privateRoot, "new-directory", "secret.txt"), "nested-after-initialization");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, launch);
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    // Linux may permit writes into its empty private-path mask, never the host data.
    assert.equal(await readFile(path.join(privateRoot, "secret.txt"), "utf8"), "synthetic-agent-data");
    await assert.rejects(stat(outsideFile), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(result.stdout), {
      workspaceWrite: true, secretReadDenied: true, privateReadDenied: true, newPrivateReadDenied: true,
      newNestedPrivateReadDenied: true,
      outsideWriteDenied: true, environmentScrubbed: true, childReadDenied: true, networkDenied: true,
    });
  } finally {
    delete process.env.CHATSTUDIO_TEST_SECRET;
    server.close();
    await SandboxManager.reset();
    await rm(base, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("internet switch allows and then blocks public outbound connections through the sandbox proxy", {
  skip: !["darwin", "linux", "win32"].includes(process.platform), timeout: 120_000,
}, async () => {
  const base = await mkdtemp(path.join(process.platform === "win32" ? process.cwd() : homedir(), ".chatstudio-network-test-"));
  const workspace = path.join(base, "workspace"), privateRoot = path.join(base, "private");
  try {
    await mkdir(workspace); await mkdir(privateRoot);
    const script = path.join(workspace, "network.mjs");
    await writeFile(script, `
      import http from "node:http";
      const proxy = new URL(process.env.HTTP_PROXY || process.env.http_proxy);
      const request = http.request({
        host: proxy.hostname, port: proxy.port, method: "CONNECT", path: "example.com:443",
        headers: { Host: "example.com:443", ...(proxy.username ? {
          "Proxy-Authorization": "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64")
        } : {}) }
      });
      request.on("connect", (response, socket) => { console.log(response.statusCode); socket.destroy(); });
      request.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
      request.setTimeout(10000, () => request.destroy(new Error("Proxy connection timed out")));
      request.end();
    `);
    for (const internetAccess of [false, true, false]) {
      const { warnings: _warnings, ...launch } = await prepareSandbox({
        workspace, internetAccess, backend: { command: process.execPath, args: ["--preserve-symlinks-main", script], readRoots: [], environment: {} },
      }, privateRoot);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, launch);
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Sandbox probe exited ${code} (${signal}): ${stderr || stdout}`)));
      });
      assert.equal(output, internetAccess ? "200" : "403");
      await SandboxManager.reset();
    }
  } finally { await SandboxManager.reset(); await rm(base, { recursive: true, force: true }); }
});
