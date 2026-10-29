import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, validateConfig } from "../src/main/config.js";
import { sandboxPolicy } from "../src/main/sandbox.js";

test("custom endpoint settings persist only normalized URL and model, never credentials", () => {
  const config = defaultConfig();
  const customEndpoint = { baseUrl: " https://company.example/litellm/v1/ ", model: " my-deployment ", apiKey: "not-saved" };
  assert.deepEqual(validateConfig({ ...config, customEndpoint }).customEndpoint,
    { baseUrl: "https://company.example/litellm/v1", model: "my-deployment" });
  assert.equal(validateConfig(config).customEndpoint, undefined);
  for (const baseUrl of ["", "not-a-url", "file:///tmp/api", "https://user:password@example.com/v1",
    "https://company.example/v1?key=secret", "https://company.example/v1#secret"]) {
    assert.throws(() => validateConfig({ ...config, customEndpoint: { baseUrl, model: "model" } }), /URL/);
  }
  assert.throws(() => validateConfig({ ...config, customEndpoint: { baseUrl: "http://localhost:4000/v1", model: " " } }), /model/);
  assert.equal(validateConfig({ ...config, customEndpoint: { baseUrl: "http://localhost:4000/v1", model: "local" } })
    .customEndpoint?.baseUrl, "http://localhost:4000/v1");
});

test("configuration requires dedicated absolute project and runtime paths", () => {
  const config = defaultConfig();
  assert.deepEqual(validateConfig(config), config);
  assert.throws(() => validateConfig(config, true), /Select a workspace/);
  assert.throws(() => validateConfig({ ...config, workspace: homedir() }), /dedicated/);
  assert.throws(() => validateConfig({ ...config, workspace: "relative" }), /absolute/);
  assert.throws(() => validateConfig({ ...config, backend: { ...config.backend, readRoots: [path.parse(homedir()).root] } }), /specific/);
});

test("configuration cannot inject provider secrets or disable sandbox through environment", () => {
  const config = defaultConfig();
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OSMCP_SANDBOX", "PATH", "NODE_OPTIONS"]) {
    assert.throws(() => validateConfig({ ...config, backend: { ...config.backend, environment: { [key]: "unsafe" } } }), /Unsupported/);
  }
});

test("sandbox policy denies network, home reads, private state and writes outside workspace", () => {
  const policy = sandboxPolicy("/project", ["/runtime"], "/private-state");
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.equal(policy.network.strictAllowlist, true);
  assert.deepEqual(policy.filesystem.allowWrite, ["/project"]);
  assert.deepEqual(policy.filesystem.denyRead, [
    homedir(), "/private-state",
  ]);
});

test("internet access is opt-in, validated, persisted and only changes network policy", () => {
  const config = defaultConfig();
  assert.equal(validateConfig(config).internetAccess, undefined);
  assert.equal(validateConfig({ ...config, internetAccess: true }).internetAccess, true);
  assert.equal(validateConfig({ ...config, internetAccess: false }).internetAccess, false);
  assert.throws(() => validateConfig({ ...config, internetAccess: "true" }), /internet access/);
  const offline = sandboxPolicy("/project", ["/runtime"], "/private-state");
  const online = sandboxPolicy("/project", ["/runtime"], "/private-state", true);
  assert.equal(online.network.strictAllowlist, false);
  assert.deepEqual(online.filesystem, offline.filesystem);
  assert.equal(online.network.allowLocalBinding, false);
});
