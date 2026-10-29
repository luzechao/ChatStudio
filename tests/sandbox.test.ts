import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { prepareSandbox } from "../src/main/sandbox.js";

test("real OS sandbox blocks sibling/private reads, outside writes, child escape, network and inherited secrets", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
  timeout: 30_000,
}, async () => {
  const base = await mkdtemp(path.join(homedir(), ".chatstudio-test-"));
  const workspace = path.join(base, "workspace");
  const privateRoot = path.join(base, "private");
  const secret = path.join(base, "secret.txt");
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
    await writeFile(script, `
      import fs from 'node:fs';
      import net from 'node:net';
      import {spawnSync} from 'node:child_process';
      const blocked = (fn) => {try {fn();return false;}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;return true;}};
      const out = {};
      fs.writeFileSync(${JSON.stringify(path.join(workspace, "allowed.txt"))}, 'allowed');
      out.workspaceWrite = true;
      out.secretReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(secret)}));
      out.privateReadDenied = blocked(()=>fs.readFileSync(${JSON.stringify(path.join(privateRoot, "secret.txt"))}));
      out.outsideWriteDenied = blocked(()=>fs.writeFileSync(${JSON.stringify(path.join(base, "escape.txt"))}, 'no'));
      out.environmentScrubbed = !process.env.CHATSTUDIO_TEST_SECRET;
      const child=spawnSync(process.execPath,['-e',${JSON.stringify(`try {require('fs').readFileSync(${JSON.stringify(secret)});process.exit(1)}catch(e){process.exit(['EPERM','EACCES'].includes(e.code)?0:2)}`)}],{encoding:'utf8'});
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
      workspace, backend: { command: process.execPath, args: [script], readRoots: [], environment: {} },
    }, privateRoot);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, launch);
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      workspaceWrite: true, secretReadDenied: true, privateReadDenied: true,
      outsideWriteDenied: true, environmentScrubbed: true, childReadDenied: true, networkDenied: true,
    });
  } finally {
    delete process.env.CHATSTUDIO_TEST_SECRET;
    server.close();
    await SandboxManager.reset();
    await rm(base, { recursive: true, force: true });
  }
});
