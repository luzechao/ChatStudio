# ChatStudio

A local-first desktop building energy modeling assistant. Electron + React supplies
the interface; Pi supplies the agent loop; native OpenStudio MCP supplies tools and
workflow guidance. Modeling and simulation use native desktop runtimes.

**Status: working development preview, verified on macOS ARM64. Not yet a packaged
cross-platform release or a complete simulation distribution.**

## What works

- Desktop chat UI, streaming Pi events, provider/model selection, and user API keys.
- Light, Dark, and Follow system appearance options in the sidebar. Follow system
  is the default and updates live; your choice is saved across restarts.
- A separate Electron utility process for the Pi agent and MCP client.
- Native MCP execution wrapped in Anthropic Sandbox Runtime, with no unsandboxed fallback.
- Tool discovery/search rather than placing all 206 tool schemas in every model request.
- Explicit approval for backend tools, including reads, with optional per-tool
  session permission and revocation.
- Native OpenStudio 3.11.0 Python model creation, inspection, and OSM saving.
- Discovery of all 206 upstream tools and all 18 workflow skills.
- Project/runtime settings on disk; API keys and conversations in memory only.

Discovery does **not** establish that every tool works. CLI simulations, Ruby
Measures, ComStock, reporting Measures, and gbXML workflows need additional native
assets described below. Skills are retrieved through MCP tools; their presence
does not imply their complete workflows are runnable.

## Run on this Mac

The Node dependencies and isolated Python SDK/MCP environment have already been
installed during initial development.

```sh
cd /Users/zlu/Documents/GitHub/ChatStudio
npm run dev
```

In Settings:

1. Select an API-key provider/model and enter your key. No API key is bundled.
2. The native setup configuration is detected automatically when no saved settings exist.
3. Click **Connect sandboxed backend**.
4. Open chat and try: “Create an example OSM, summarize it, and save it.”
5. Review requested backend calls. Choose **Allow once**, **Deny**, or
   **Allow this tool for this session**.

Generated models live under the selected project's `runs/` directory. The initial
project is `projects/first-building/`. Copy inputs into its `inputs/` folder;
absolute paths are visible in Settings and should be used in tool requests.

Provider requests send chat and selected tool results to the chosen provider.
Local modeling does not imply private/offline inference.

### Session tool permissions

**Allow this tool for this session** approves the current call and future calls
to that exact tool with any arguments. Other tools still prompt. Active grants
appear under **Allowed this session** in the sidebar, with a **Revoke** button
for each. Revoking affects future calls, not work already running.

Grants stay in memory only and clear on New conversation, backend reconnect or
disconnect, provider/model/endpoint changes, and app restart. Stop cancels pending
approvals but preserves existing grants. The OS sandbox and tool/turn limits
remain enforced for automatically approved calls.

### OpenAI-compatible endpoints / LiteLLM

In Settings, select **OpenAI-compatible / LiteLLM**, enter the **API base URL**
(for example `https://company-gateway.example/v1`) and the exact **Model /
deployment name** configured by your company. Use the API root, not the
`/chat/completions` endpoint. Enter the gateway's key in the API key field, then
choose **Open chat** (or connect the modeling backend).

The base URL and model are saved across restarts; the key is memory-only and
must be re-entered after restart. Requests use streaming Chat Completions with
tool calling, so the deployment must support these features for modeling.
Custom models default to a 32,768-token context and 4,096-token output budget.
Use HTTPS for company services; HTTP is available for trusted local development.
The configured endpoint receives your key, chat, and tool results. System-trusted
company CA certificates are supported without disabling TLS verification.
Start a new conversation before changing provider, model, or endpoint.

## Set up another development machine

Requirements: Node.js >= 22.19, npm, Git, and a Python version with an OpenStudio
3.11.0 wheel for the target OS/architecture. Python 3.13 was verified on this Mac.
The host must also support the required native process sandbox.

```sh
npm ci
# If npm blocked Electron's download lifecycle script:
node node_modules/electron/install.js

# macOS example; otherwise choose an appropriate installed Python.
CHATSTUDIO_PYTHON=python3.13 npm run setup:native
npm run dev
```

The native setup script creates `.runtime/venv`, checks out MCP commit
`e0a47a9c50aa6c52f77ba63540118bb816d12726`, installs it from
`requirements-native.txt`, and writes `.runtime/backend.json`.
It does not modify global Python packages or install a system-wide OpenStudio.
Review the read-only runtime paths it grants. Homebrew Python requires access to
its interpreter framework and linked library packages; the setup script derives
those paths using `otool` on macOS.

Node dependencies are locked in `package-lock.json`. The native MCP revision and
SDK version are pinned, but all transitive Python dependencies are not yet locked.
Overrides pin patched Undici and Zod releases; Zod's compatibility exports retain
the dependency APIs used by MCP/Sandbox Runtime. The integration gates cover them.

## Architecture

```text
Sandboxed Electron renderer (React, no Node or direct network access)
    |
    | Narrow, sender-checked preload IPC
    v
Electron main process (settings and desktop lifecycle)
    |
    v
Agent utility process (Pi, in-memory provider credentials)
    |
    | MCP stdio
    v
OS-sandboxed native MCP process and its descendants
    |
    +-- Native OpenStudio Python SDK
    +-- OpenStudio CLI / Ruby / Measures [additional installation]
    +-- EnergyPlus [additional installation]
```

Pi's built-in shell/file tools, arbitrary extensions, project instructions, and
automatic skill-file execution are disabled. The two exposed agent tools search
the backend catalog and invoke approved MCP tools. MCP skill documents are treated
as untrusted workflow guidance, not executable Pi extensions.

Changing the provider/model requires a new conversation. Reconnecting the backend
resets Pi's conversation to avoid stale model context. New conversation resets chat,
not the MCP server's current building model. All sessions are ephemeral in this preview.

## Sandbox boundaries and limitations

- The entire MCP server and its descendants are wrapped, not just the EnergyPlus executable.
- User-home reads are denied except explicitly allowed project/dependency roots.
- ChatStudio private state is denied. Dependencies are read-only.
- Workspace writes are allowed; the runtime additionally permits its standard
  temporary/device paths. This is not a hermetic filesystem image.
- Direct backend network access is denied. BCL downloads, package installation,
  and remote analysis are deliberately unavailable during execution.
- Provider keys are not forwarded to the MCP process. Native environment overrides
  are restricted to recognized runtime configuration variables.
- Approvals expire after two minutes. There is a per-message backend-call limit
  and agent-turn limit.
- **Stop** aborts the agent/request. It is not a guarantee that a simulation job
  already accepted by MCP has stopped; use the backend's `cancel_run` workflow.
- The agent process itself is trusted and not OS-sandboxed; it needs provider
  access. Only the MCP process tree is confined.
- The current macOS mechanism uses deprecated `sandbox-exec`, as used by the
  selected Sandbox Runtime release. It is defense in depth, not a VM boundary.
- **macOS ARM64:** actual filesystem, network, child-process, and secret-environment
  denial tests passed, including a real native SDK/MCP workflow.
- **Linux:** implementation targets Sandbox Runtime's bubblewrap backend, but has
  not been validated here. Install its required dependencies and run the gates.
- **Windows:** UI architecture is portable, but native backend launch intentionally
  refuses execution until the Windows confinement/launch adapter is validated.
  There is no automatic insecure mode.

Do not grant all of your home directory or place provider secrets in projects or
runtime folders. This preview is not certified for executing hostile third-party
code and has no hard CPU/memory quota implementation.

## Completing the native simulation distribution

The Python SDK is **3.11.0**, matching the upstream MCP package.

For the remaining workflows, install a matching native OpenStudio distribution
with its CLI, Ruby bindings/runtime, and matching EnergyPlus. In runtime settings:

- Set `OPENSTUDIO_CLI` to the absolute CLI executable. ChatStudio adds its directory
  to the child's PATH; upstream commands invoke `openstudio`.
- Add the installation's dependency roots to read-only paths.
- Set `OSCLI_GEMFILE` and `OSCLI_GEM_PATH` for the required gem environment.
- Install and configure `COMMON_MEASURES_DIR`, `COMSTOCK_MEASURES_DIR`,
  `GBXML_MEASURES_DIR`, and `GBXML_SEED_OSM` as needed.

The upstream Docker recipe documents the expected asset versions, but ChatStudio
does not require or run Docker. Distribution packaging, license notices, signing,
runtime relocation, and full tool coverage remain work.

## Validation

The AI agent uses both bundled and operating-system trusted CA certificates.
This supports HTTPS inspection with a locally trusted certificate, including
OpenRouter connections. TLS certificate verification remains enabled; untrusted
or invalid certificates are not accepted.

```sh
npm run typecheck
npm test                    # Config, approvals, actual OS confinement probes
npm run test:native         # Requires setup:native; real SDK/MCP and Pi loop
npm run build
npm run test:desktop        # Requires build + setup:native; launches real Electron
npm run test:provider       # Requires build; local OpenAI-compatible HTTP diagnostic
npm audit
```

The native gate uses Pi's scripted local test provider, not a paid/cloud model.
It verifies discovery of 206 tools/18 skills, approved native model creation,
exact model counts (four spaces, one thermal zone), OSM persistence, denied edits,
disabled general agent tools, and credential cleanup. Live provider inference
requires the user's key and was not exercised during development.

The desktop gate verifies the renderer/preload boundary, catalog loading, real
sandboxed MCP connection, disconnect behavior, and captures a local preview.
All development helpers exit after verification.

The provider diagnostic starts an ephemeral, loopback-only OpenAI-compatible mock
host and sends requests through the real ChatAgent/Pi stack in an Electron utility
process. It checks streamed text, request paths/authentication, HTTP 401/429
errors, dropped connections, and credential cleanup. It requires no real API key,
native MCP runtime, or paid inference. The host is a protocol fixture, not a local
language model, and shuts down after the test. A passing result isolates basic
request/streaming behavior; it does not verify a specific remote provider or key.

## Next milestones

1. Bundle and validate the CLI, EnergyPlus, Ruby gems, and Measure assets.
2. Add verified simulation/cancellation/reporting workflows and capability indicators.
3. Add model viewing, artifacts/results browsing, and model revision checkpoints.
4. Add optional encrypted credential persistence and conversation history.
5. Validate Linux/Windows confinement and ship signed platform-specific installers.

## Desktop builds and GitHub releases

The GitHub Actions workflow builds macOS Apple Silicon (DMG and ZIP),
Windows x64 (NSIS installer), and Linux x64 (AppImage and DEB). Pushes to `main`,
pull requests, and manual runs execute type checks, unit tests, local provider
diagnostics, packaging, and a packaged-app smoke test. Linux confinement tests
run on the disposable runner with bubblewrap prerequisites installed; Windows
confinement is not implemented and is never bypassed.

Build artifacts are retained for 14 days. To create a release, update the package
version and lockfile, commit, and push a matching `v<version>` tag. After every
platform passes, the workflow creates a **draft prerelease** with installers and
SHA-256 checksums. Review and test it before publishing. The workflow token only
has repository-write access in the release job.

These are **unsigned desktop previews**, not complete native runtime bundles.
The installed app contains neither development projects nor `.runtime`, keys,
or a relocatable Python/OpenStudio distribution. macOS/Linux users must configure
an external native runtime. Windows supports AI chat/settings but refuses native
modeling until its sandbox launch adapter is validated. Signing/notarization,
runtime bundling, Ruby gem/Measure assets, licensing review, and full native
workflow verification remain release blockers for production distributions.

Local packaging:

```sh
npm run package -- --mac --arm64  # On Apple Silicon macOS
npm run package -- --win --x64    # On Windows
npm run package -- --linux --x64  # On Linux
CHATSTUDIO_EXECUTABLE="release/mac-arm64/ChatStudio.app/Contents/MacOS/ChatStudio" npm run test:package
```

Resources are deliberately unpacked (`asar: false`) so utility processes and
native sandbox helper executables can use real filesystem paths. The packaging
allowlist includes built application code and production dependencies only.
