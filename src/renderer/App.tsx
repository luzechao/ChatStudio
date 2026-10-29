import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AppConfig, Conversation, CredentialScope, ModelChoice, ProjectInfo, ProjectState } from "../shared/contracts.js";
import { errorMessage } from "../shared/contracts.js";
import { CUSTOM_PROVIDER, validateCustomEndpoint } from "../shared/contracts.js";
import { isThemePreference, resolveTheme, THEME_STORAGE_KEY, type ThemePreference } from "./theme.js";
import { MessageContent } from "./MessageContent.js";
import { ProjectViewer } from "./ProjectViewer.js";

interface Message { role: "user" | "assistant"; text: string }
const initial: AppConfig = { workspace: "", backend: { command: "", args: [], readRoots: [], environment: {} } };
const logoUrl = new URL("../../assets/chatstudio-logo.svg", import.meta.url).href;

export function App() {
  const [config, setConfig] = useState(initial);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(true);
  const [keyChanged, setKeyChanged] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [recentProjects, setRecentProjects] = useState<ProjectInfo[]>([]);
  const [archive, setArchive] = useState<Conversation | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "model" | "results">("chat");
  const [projectBusy, setProjectBusy] = useState(true);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hasBundledRuntime, setHasBundledRuntime] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const [status, setStatus] = useState("Native backend not connected");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(true);
  const [approval, setApproval] = useState<Extract<AgentEvent, { type: "approval" }> | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [argsText, setArgsText] = useState("[]");
  const [rootsText, setRootsText] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [theme, setTheme] = useState<ThemePreference>("system");
  const end = useRef<HTMLDivElement>(null);
  const credentialScope = useMemo<CredentialScope | null>(() => {
    if (provider !== CUSTOM_PROVIDER) return { provider };
    try { return { provider, baseUrl: validateCustomEndpoint({ baseUrl, model: "credential" }).baseUrl }; }
    catch { return null; }
  }, [provider, baseUrl]);

  useEffect(() => {
    let active = true;
    setApiKey(""); setRememberKey(false); setKeyChanged(false); setEncryptionAvailable(false);
    if (!credentialScope) { setCredentialBusy(false); return; }
    setCredentialBusy(true);
    void window.chatstudio.loadCredential(credentialScope).then((saved) => {
      if (!active) return;
      setEncryptionAvailable(saved.available); setRememberKey(saved.saved); setApiKey(saved.apiKey ?? "");
    }).catch((e: unknown) => { if (active) setError(errorMessage(e)); })
      .finally(() => { if (active) setCredentialBusy(false); });
    return () => { active = false; };
  }, [credentialScope]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved !== null && !isThemePreference(saved)) throw new Error("Invalid saved appearance preference. Select an appearance to replace it.");
      if (isThemePreference(saved)) setTheme(saved);
    } catch (e) { setError(errorMessage(e)); }
  }, []);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme = resolveTheme(theme, system.matches);
    };
    update();
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [theme]);

  function changeTheme(value: string) {
    if (!isThemePreference(value)) return;
    setTheme(value);
    try { localStorage.setItem(THEME_STORAGE_KEY, value); }
    catch (e) { setError(`Could not save appearance: ${errorMessage(e)}`); }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([window.chatstudio.loadConfig(), window.chatstudio.catalog(), window.chatstudio.bundledRuntime("")]).then(async ([saved, choices, bundled]) => {
      if (!active) return;
      setConfig(saved); setModels(choices);
      setHasBundledRuntime(bundled !== null);
      setArgsText(JSON.stringify(saved.backend.args));
      setRootsText(saved.backend.readRoots.join("\n"));
      setEnvText(JSON.stringify(saved.backend.environment, null, 2));
      if (saved.customEndpoint) {
        setBaseUrl(saved.customEndpoint.baseUrl); setCustomModel(saved.customEndpoint.model);
        setProvider(CUSTOM_PROVIDER);
      }
      if (saved.workspace) {
        const state = await window.chatstudio.openProject(saved.workspace);
        if (active) setProject(state);
      }
      const recent = await window.chatstudio.recentProjects();
      if (active) setRecentProjects(recent);
    }).catch((e: unknown) => { if (active) setError(errorMessage(e)); })
      .finally(() => { if (active) setProjectBusy(false); });
    const unsubscribe = window.chatstudio.onEvent((event) => {
      if (event.type === "text") setMessages((current) => {
        const last = current.at(-1);
        return last?.role === "assistant"
          ? [...current.slice(0, -1), { ...last, text: last.text + event.text }]
          : [...current, { role: "assistant", text: event.text }];
      });
      else if (event.type === "backend") {
        setConnected(event.connected); setToolCount(event.tools);
        setStatus(event.connected ? "Local engine ready" : "Local engine disconnected");
        if (!event.connected) { setPermissions([]); setApproval(null); }
      } else if (event.type === "error") setError(event.message);
      else if (event.type === "approval") setApproval(event);
      else if (event.type === "permissions") setPermissions(event.tools);
      else if (event.type === "tool") setStatus(`${event.name}: ${event.error ? "failed" : event.phase === "start" ? "running" : "finished"}`);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (provider === CUSTOM_PROVIDER) return;
    const choices = models.filter((m) => m.provider === provider);
    setModel(choices.find((m) => /sonnet|gpt-5|gemini.*pro/i.test(m.id))?.id ?? choices[0]?.id ?? "");
  }, [provider, models]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, approval]);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try { await action(); } catch (e) { setError(errorMessage(e)); }
  }

  async function saveSettings(): Promise<AppConfig> {
    const parsed: AppConfig = {
      ...config, backend: { ...config.backend, args: JSON.parse(argsText),
        readRoots: rootsText.split("\n").map((s) => s.trim()).filter(Boolean), environment: JSON.parse(envText) },
    };
    if (provider === CUSTOM_PROVIDER) parsed.customEndpoint = validateCustomEndpoint({ baseUrl, model: customModel });
    else delete parsed.customEndpoint;
    if (credentialBusy) throw new Error("Wait for API key storage to finish.");
    if (rememberKey && apiKey) {
      if (!credentialScope) throw new Error("Enter a valid API base URL before saving the key.");
      setCredentialBusy(true);
      try {
        await window.chatstudio.saveCredential(credentialScope, apiKey);
        setKeyChanged(false);
      } finally { setCredentialBusy(false); }
    }
    await window.chatstudio.saveConfig(parsed);
    setConfig(parsed);
    return parsed;
  }

  async function rememberCredential(remember: boolean) {
    if (!credentialScope) throw new Error("Select a provider and valid API base URL first.");
    setCredentialBusy(true);
    try {
      if (remember) await window.chatstudio.saveCredential(credentialScope, apiKey);
      else {
        await window.chatstudio.forgetCredential(credentialScope);
        setEncryptionAvailable((await window.chatstudio.loadCredential(credentialScope)).available);
      }
      setRememberKey(remember); setKeyChanged(false);
    } finally { setCredentialBusy(false); }
  }

  async function connect() {
    setConnecting(true);
    await run(async () => {
      const parsed = await saveSettings();
      await window.chatstudio.connect(parsed);
      setSettings(false);
    });
    setConnecting(false);
  }

  async function changeInternetAccess(enabled: boolean) {
    setNetworkBusy(true); setProjectBusy(true);
    try {
      if (connected) await window.chatstudio.disconnect();
      const next = { ...config, internetAccess: enabled };
      await window.chatstudio.saveConfig(next);
      setConfig(next);
    } finally { setNetworkBusy(false); setProjectBusy(false); }
  }

  async function refreshProject() {
    if (project) setProject(await window.chatstudio.projectState());
  }

  async function openProject(workspace: string) {
    setProjectBusy(true);
    try {
      const state = await window.chatstudio.openProject(workspace);
      const next = { ...config, workspace: state.project.path };
      setConfig(next); setProject(state); setMessages([]); setInput(""); setArchive(null); setApproval(null);
      setWorkspaceOpen(true); setSettings(false); setActiveTab("chat");
      await window.chatstudio.saveConfig(next);
      setRecentProjects(await window.chatstudio.recentProjects());
    } finally { setProjectBusy(false); }
  }

  async function send() {
    if (busy || projectBusy || archive || !input.trim()) return;
    const text = input.trim();
    setInput(""); setBusy(true); setError("");
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);
    try { await window.chatstudio.prompt({ provider, model: provider === CUSTOM_PROVIDER ? customModel.trim() : model,
      apiKey, text, ...(provider === CUSTOM_PROVIDER ? { baseUrl: baseUrl.trim() } : {}) }); }
    catch (e) { setError(errorMessage(e)); }
    finally {
      setBusy(false); setApproval(null);
      try { await refreshProject(); } catch (e) { setError(errorMessage(e)); }
    }
  }

  const providers = [...new Set(models.map((m) => m.provider))].sort();
  const selectedModel = provider === CUSTOM_PROVIDER ? customModel.trim() : model;
  return <div className="app">
    <aside>
      <div className="brand"><img className="logo" src={logoUrl} alt="ChatStudio logo" /><div><strong>ChatStudio</strong><small>BUILDING ENERGY WORKSPACE</small></div></div>
      <button className="new-chat" disabled={busy || connecting || projectBusy || viewerBusy} onClick={() => void run(async () => {
        await window.chatstudio.reset(); setMessages([]); setApproval(null); setArchive(null); setSettings(false); setWorkspaceOpen(false); setActiveTab("chat");
      })}>+ New conversation</button>
      <div className="section-label">PROJECT</div>
      <div className="project">{config.workspace.split(/[/\\]/).filter(Boolean).at(-1) || "No project selected"}</div>
      <button disabled={busy || connecting || projectBusy || viewerBusy} onClick={() => void run(async () => {
        const workspace = await window.chatstudio.chooseWorkspace();
        if (workspace) await openProject(workspace);
      })}>Open project folder</button>
      {recentProjects.length > 0 && <label>Recent projects<select aria-label="Recent projects" value={project?.project.path ?? ""}
        disabled={busy || connecting || projectBusy || viewerBusy} onChange={(e) => { if (e.target.value) void run(() => openProject(e.target.value)); }}>
        <option value="">Choose project</option>
        {recentProjects.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
      </select></label>}
      <button disabled={!project || projectBusy || busy || viewerBusy} onClick={() => { setSettings(false); setArchive(null); setActiveTab("chat"); setWorkspaceOpen(!workspaceOpen); }}>Project workspace</button>
      <section aria-label="Project conversation history">
        <div className="section-label">CONVERSATIONS</div>
        <small>{project ? "Saved locally for this project" : "Open a project to save conversations"}</small>
        <div className="history-list">
          {project?.conversations.map((conversation) => <button key={conversation.id} className={archive?.id === conversation.id ? "history-selected" : ""}
            disabled={busy || connecting || projectBusy || viewerBusy} onClick={() => { setArchive(conversation); setWorkspaceOpen(false); setSettings(false); setActiveTab("chat"); }}>
            <span>{conversation.title}</span><small>{new Date(conversation.updatedAt).toLocaleString()}</small>
          </button>)}
        </div>
      </section>
      <div className="section-label">LOCAL ENGINE</div>
      <div className="engine"><span className={connected ? "dot online" : "dot"} />{connected ? "Connected" : "Not connected"}</div>
      <p className="muted">{connected ? `${toolCount} native tools discovered` : "Configure your native OpenStudio MCP runtime to enable modeling."}</p>
      {permissions.length > 0 && <section aria-label="Session tool permissions">
        <div className="section-label">ALLOWED THIS SESSION</div>
        <small>Any arguments. Revoking affects future calls, not work already running.</small>
        {permissions.map((name) => <div className="permission" key={name}><code>{name}</code>
          <button aria-label={`Revoke ${name}`} onClick={() => void run(() => window.chatstudio.revokePermission(name))}>Revoke</button>
        </div>)}
      </section>}
      <div className="sidebar-bottom">
        <button disabled={viewerBusy || networkBusy} onClick={() => setSettings(!settings)}>{settings ? "Close settings" : "Settings"}</button>
        <small>Desktop preview / 0.1.0</small>
      </div>
    </aside>
    <main>
      <header><nav aria-label="Main views" className="main-tabs">
        {(["chat", "model", "results"] as const).map((tab) => <button key={tab} aria-current={!settings && activeTab === tab && !workspaceOpen ? "page" : undefined}
          disabled={viewerBusy || (tab !== "chat" && (busy || connecting || projectBusy || !project))}
          onClick={() => { setActiveTab(tab); setSettings(false); setWorkspaceOpen(false); }}>
          {tab === "chat" ? "Chat" : tab === "model" ? "Model" : "Results"}
        </button>)}
      </nav></header>
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {settings ? <section className="settings">
        <h1>Set up your workspace</h1>
        <p>ChatStudio runs native building tools locally. Your selected LLM receives chat and tool results.</p>
        <h2>Appearance</h2>
        <label className="appearance">Appearance<select aria-label="Appearance" value={theme} onChange={(e) => changeTheme(e.target.value)}>
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select></label>
        <h2>Internet access</h2>
        <label className="remember-key"><input type="checkbox" role="switch" aria-label="Internet access"
          checked={config.internetAccess === true} disabled={busy || connecting || projectBusy || viewerBusy || networkBusy}
          onChange={(e) => void run(() => changeInternetAccess(e.target.checked))} />Allow local modeling tools to access the internet</label>
        <small>Off by default. Turning this on lets approved modeling tools download resources or send project data to internet services.
          AI-provider connections are separate and remain available. File protections stay active.
          Changing this disconnects the local engine and clears tool permissions; reconnect to apply it. Viewers remain offline.</small>
        <h2>AI provider</h2>
        <div className="row">
          <label>Provider<select aria-label="Provider" value={provider} disabled={busy || credentialBusy || messages.length > 0} onChange={(e) => { setProvider(e.target.value); setApiKey(""); }}>
            {!providers.length && <option value="anthropic">Loading catalog...</option>}
            <option value={CUSTOM_PROVIDER}>OpenAI-compatible / LiteLLM</option>
            {providers.map((p) => <option key={p}>{p}</option>)}
          </select></label>
          {provider === CUSTOM_PROVIDER ? <label>Model / deployment name<input value={customModel} disabled={busy || messages.length > 0}
            onChange={(e) => setCustomModel(e.target.value)} placeholder="Your LiteLLM model alias" /></label> : <label>Model<select aria-label="Model" value={model} disabled={busy || messages.length > 0} onChange={(e) => setModel(e.target.value)}>
            {models.filter((m) => m.provider === provider).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></label>}
        </div>
        {provider === CUSTOM_PROVIDER && <>
          <label>API base URL<input type="url" value={baseUrl} disabled={busy || credentialBusy || messages.length > 0}
            onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-litellm-gateway/v1" /></label>
          <small>Use the API root, including /v1 if required, not /chat/completions. This endpoint receives your key, chat,
            and tool results. Use HTTPS except for trusted local development. Supports streaming Chat Completions;
            model limits default to 32,768 context tokens and 4,096 output tokens.</small>
        </>}
        <label>API key<input type="password" autoComplete="off" value={apiKey} disabled={busy || credentialBusy}
          onChange={(e) => { setApiKey(e.target.value); setKeyChanged(true); }} placeholder="Enter your provider API key" /></label>
        <label className="remember-key"><input type="checkbox" checked={rememberKey}
          disabled={busy || credentialBusy || !credentialScope || (!rememberKey && (!encryptionAvailable || !apiKey.trim()))}
          onChange={(e) => void run(() => rememberCredential(e.target.checked))} />Remember API key on this device</label>
        <small>{credentialBusy ? "Checking secure key storage..."
          : !credentialScope ? "Enter a valid API base URL to enable encrypted key storage."
          : !encryptionAvailable ? "Secure OS encryption is unavailable. Keys cannot be saved or restored; you can still enter a key for this session."
          : rememberKey ? keyChanged ? "Key changed. Update the saved key or open chat to save it." : "API key saved with OS encryption for this provider/endpoint."
          : "Optional: save with OS encryption. Otherwise the key stays in memory for this session."}
          {" "}Keys are never passed to the modeling backend.</small>
        <div className="row actions">
          {rememberKey && keyChanged && <button disabled={busy || credentialBusy || !encryptionAvailable || !apiKey.trim()}
            onClick={() => void run(() => rememberCredential(true))}>Update saved key</button>}
          <button disabled={busy || credentialBusy || !credentialScope}
            onClick={() => void run(() => rememberCredential(false))}>Forget saved key</button>
        </div>
        <h2>Native OpenStudio MCP</h2>
        <p>{config.bundledRuntime
          ? "Bundled OpenStudio, EnergyPlus, Python, Ruby/gems, and Measure assets are ready. Choose a project and connect."
          : "Supply an installed MCP executable, its Python/SDK dependencies, and Measure assets."}</p>
        {hasBundledRuntime && <button disabled={busy || connected || connecting} onClick={() => void run(async () => {
          if (config.bundledRuntime) { setConfig((current) => ({ ...current, bundledRuntime: false })); return; }
          const bundled = await window.chatstudio.bundledRuntime(config.workspace);
          if (!bundled) throw new Error("This build has no bundled native runtime.");
          setConfig((current) => ({ ...current, ...bundled }));
          setArgsText(JSON.stringify(bundled.backend.args));
          setRootsText(bundled.backend.readRoots.join("\n"));
          setEnvText(JSON.stringify(bundled.backend.environment, null, 2));
        })}>{config.bundledRuntime ? "Configure external runtime" : "Use included native runtime"}</button>}
        <label>Project folder<input readOnly value={config.workspace} placeholder="Choose a project folder in the sidebar" /></label>
        <label>MCP executable (absolute path)<input disabled={connected || connecting || config.bundledRuntime} value={config.backend.command}
          onChange={(e) => setConfig((c) => ({ ...c, backend: { ...c.backend, command: e.target.value } }))}
          placeholder="/absolute/path/to/venv/bin/openstudio-mcp" /></label>
        <label>Arguments (JSON array)<input disabled={connected || connecting || config.bundledRuntime} value={argsText} onChange={(e) => setArgsText(e.target.value)} /></label>
        <label>Read-only dependency folders (one absolute path per line)<textarea disabled={connected || connecting || config.bundledRuntime} value={rootsText}
          onChange={(e) => setRootsText(e.target.value)} placeholder="Python runtime, SDK installation, MCP source, Measures and skills folders" /></label>
        <label>Runtime environment (JSON object)<textarea disabled={connected || connecting || config.bundledRuntime} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
        <small>Advanced runtime settings. Never put API keys here.</small>
        <div className="row actions">
          <button className="primary" disabled={busy || networkBusy || credentialBusy || connecting || connected || projectBusy} onClick={() => void connect()}>{connecting ? "Connecting..." : "Connect local engine"}</button>
          <button disabled={busy || connecting || !connected} onClick={() => void run(() => window.chatstudio.disconnect())}>Disconnect</button>
          <button disabled={busy || networkBusy || credentialBusy || connecting || !apiKey || !selectedModel} onClick={() => void run(async () => {
            await saveSettings(); setSettings(false); setWorkspaceOpen(false); setArchive(null); setActiveTab("chat");
          })}>Open chat</button>
        </div>
      </section> : activeTab !== "chat" && project ? <section className="workspace">
        <div className="workspace-heading"><div><h1>{activeTab === "model" ? "Model" : "Results"}</h1><p>{project.project.name}</p></div>
          <button disabled={viewerBusy} onClick={() => void run(refreshProject)}>Refresh</button></div>
        <ProjectViewer key={`${project.project.path}:${activeTab}`} project={project} initialMode={activeTab} disabled={busy || connecting || projectBusy} onBusy={setViewerBusy} />
      </section> : workspaceOpen && project ? <section className="workspace">
        <div className="workspace-heading"><div><h1>{project.project.name}</h1><p>{project.project.path}</p></div>
          <button disabled={viewerBusy} onClick={() => void run(refreshProject)}>Refresh</button>
          <button disabled={viewerBusy} onClick={() => setWorkspaceOpen(false)}>Back to chat</button></div>
        <p>Inputs, models, Measures, and simulation outputs stay in your project folder. Conversations are stored privately by ChatStudio, grouped by this folder.</p>
        <p>Use the Model and Results tabs above to view saved models and simulation outputs.</p>
        <h2>Project files</h2>
        {!project.files.length ? <p>No files yet. Add an OSM or weather file to the project’s inputs folder.</p>
          : <div className="project-files"><table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>
            {project.files.map((file) => <tr key={file.path}><td>{file.path}</td><td>{(file.size / 1024).toFixed(1)} KB</td></tr>)}
          </tbody></table></div>}
        {project.truncated && <p>Showing a limited file listing. Nested or additional files are not displayed.</p>}
      </section> : <>
        <section className="conversation">
          {archive && <div className="archive-banner"><strong>Saved conversation</strong><p>{archive.title}</p>
            <small>Read-only history. Tool actions are not replayed; the current chat is unchanged.</small>
            <button onClick={() => setArchive(null)}>Back to current chat</button></div>}
          {!archive && !messages.length && <div className="welcome"><div className="eyebrow">YOUR BUILDING. A CLEARER PICTURE.</div>
            <h1>What would you like<br />to explore?</h1>
            <p>Create, inspect, and improve building energy models<br />with native OpenStudio tools and a conversational guide.</p>
            <div className="suggestions">{["Summarize my building model", "Help me choose an HVAC system", "Explain simulation warnings"].map((text) =>
              <button key={text} onClick={() => setInput(text)}>{text}<span>↗</span></button>)}</div>
          </div>}
          {(archive?.messages ?? messages).map((m, i) => <article key={i} className={`message ${m.role}`} aria-label={m.role === "user" ? "Your message" : "ChatStudio reply"}>
            <div className="speaker">{m.role === "user" ? <span className="message-avatar" aria-hidden="true">Y</span>
              : <img className="message-avatar" src={logoUrl} alt="" />}
              {m.role === "user" ? "You" : "ChatStudio"}</div>
            <div className="message-text">{m.text
              ? m.role === "assistant" ? <MessageContent text={m.text} /> : m.text
              : <span className="message-placeholder">{busy ? "Thinking..." : "No text returned. Check diagnostics above."}</span>}</div>
          </article>)}
          {!archive && approval && <div className="approval" role="dialog" aria-label="Approve tool execution"><strong>Allow {approval.name}?</strong>
            <p>Review the tool and arguments before approving.</p><pre>{approval.arguments}</pre>
            <button className="primary" onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, true); setApproval(null); })}>Allow once</button>
            <button onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, true, true); setApproval(null); })}>Allow this tool for this session</button>
            <button onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, false); setApproval(null); })}>Deny</button>
            <p>Session permission allows this tool with any arguments until revoked or the conversation/backend changes.</p>
          </div>}
          <div ref={end} />
        </section>
        {!archive && <footer><form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea aria-label="Message" value={input} disabled={busy || projectBusy} maxLength={32000} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder="Ask about your building..." />
          {busy ? <button type="button" onClick={() => void run(() => window.chatstudio.abort())}>Stop</button>
            : <button className="primary" disabled={projectBusy || !input.trim() || !apiKey || !selectedModel}>Send</button>}
        </form><small>{connected ? status : "Connect the local engine in Settings to use modeling tools."}</small></footer>}
      </>}
    </main>
  </div>;
}
