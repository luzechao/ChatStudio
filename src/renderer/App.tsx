import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AppConfig, ModelChoice } from "../shared/contracts.js";
import { errorMessage } from "../shared/contracts.js";
import { CUSTOM_PROVIDER, validateCustomEndpoint } from "../shared/contracts.js";
import { isThemePreference, resolveTheme, THEME_STORAGE_KEY, type ThemePreference } from "./theme.js";

interface Message { role: "user" | "assistant"; text: string }
const initial: AppConfig = { workspace: "", backend: { command: "", args: [], readRoots: [], environment: {} } };

export function App() {
  const [config, setConfig] = useState(initial);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
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
    void Promise.all([window.chatstudio.loadConfig(), window.chatstudio.catalog()]).then(([saved, choices]) => {
      if (!active) return;
      setConfig(saved); setModels(choices);
      setArgsText(JSON.stringify(saved.backend.args));
      setRootsText(saved.backend.readRoots.join("\n"));
      setEnvText(JSON.stringify(saved.backend.environment, null, 2));
      if (saved.customEndpoint) {
        setBaseUrl(saved.customEndpoint.baseUrl); setCustomModel(saved.customEndpoint.model);
        setProvider(CUSTOM_PROVIDER);
      }
    }).catch((e: unknown) => { if (active) setError(errorMessage(e)); });
    const unsubscribe = window.chatstudio.onEvent((event) => {
      if (event.type === "text") setMessages((current) => {
        const last = current.at(-1);
        return last?.role === "assistant"
          ? [...current.slice(0, -1), { ...last, text: last.text + event.text }]
          : [...current, { role: "assistant", text: event.text }];
      });
      else if (event.type === "backend") {
        setConnected(event.connected); setToolCount(event.tools); setStatus(event.message);
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
    await window.chatstudio.saveConfig(parsed);
    setConfig(parsed);
    return parsed;
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

  async function send() {
    if (busy || !input.trim()) return;
    const text = input.trim();
    setInput(""); setBusy(true); setError("");
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);
    try { await window.chatstudio.prompt({ provider, model: provider === CUSTOM_PROVIDER ? customModel.trim() : model,
      apiKey, text, ...(provider === CUSTOM_PROVIDER ? { baseUrl: baseUrl.trim() } : {}) }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); setApproval(null); }
  }

  const providers = [...new Set(models.map((m) => m.provider))].sort();
  const selectedModel = provider === CUSTOM_PROVIDER ? customModel.trim() : model;
  return <div className="app">
    <aside>
      <div className="brand"><span className="logo">C</span><div><strong>ChatStudio</strong><small>BUILDING ENERGY WORKSPACE</small></div></div>
      <button className="new-chat" disabled={busy || connecting} onClick={() => void run(async () => {
        await window.chatstudio.reset(); setMessages([]); setApproval(null);
      })}>+ New conversation</button>
      <div className="section-label">PROJECT</div>
      <div className="project">{config.workspace.split(/[/\\]/).filter(Boolean).at(-1) || "No project selected"}</div>
      <button disabled={busy || connecting || connected} onClick={() => void run(async () => {
        const workspace = await window.chatstudio.chooseWorkspace();
        if (workspace) setConfig((c) => ({ ...c, workspace }));
      })}>Choose project folder</button>
      <div className="section-label">LOCAL ENGINE</div>
      <div className="engine"><span className={connected ? "dot online" : "dot"} />{connected ? "Connected" : "Not connected"}</div>
      <p className="muted">{connected ? `${toolCount} native tools discovered` : "Configure your native OpenStudio MCP runtime to enable modeling."}</p>
      <div className="sandbox-note">OS sandbox required<br /><small>No unsandboxed fallback</small></div>
      {permissions.length > 0 && <section aria-label="Session tool permissions">
        <div className="section-label">ALLOWED THIS SESSION</div>
        <small>Any arguments. Revoking affects future calls, not work already running.</small>
        {permissions.map((name) => <div className="permission" key={name}><code>{name}</code>
          <button aria-label={`Revoke ${name}`} onClick={() => void run(() => window.chatstudio.revokePermission(name))}>Revoke</button>
        </div>)}
      </section>}
      <div className="sidebar-bottom">
        <label className="appearance">Appearance<select aria-label="Appearance" value={theme} onChange={(e) => changeTheme(e.target.value)}>
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select></label>
        <button onClick={() => setSettings(!settings)}>{settings ? "Close settings" : "Settings & runtime"}</button>
        <small>Desktop preview / 0.1.0</small>
      </div>
    </aside>
    <main>
      <header><div><strong>Building assistant</strong><span>Local tools. Your model provider.</span></div><div className="badge">Pi agent</div></header>
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {settings ? <section className="settings">
        <h1>Set up your workspace</h1>
        <p>ChatStudio runs native building tools locally. Your selected LLM receives chat and tool results.</p>
        <h2>AI provider</h2>
        <div className="row">
          <label>Provider<select aria-label="Provider" value={provider} disabled={busy || messages.length > 0} onChange={(e) => { setProvider(e.target.value); setApiKey(""); }}>
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
          <label>API base URL<input type="url" value={baseUrl} disabled={busy || messages.length > 0}
            onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-litellm-gateway/v1" /></label>
          <small>Use the API root, including /v1 if required, not /chat/completions. This endpoint receives your key, chat,
            and tool results. Use HTTPS except for trusted local development. Supports streaming Chat Completions;
            model limits default to 32,768 context tokens and 4,096 output tokens.</small>
        </>}
        <label>API key<input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(e) => setApiKey(e.target.value)} placeholder="Kept in memory only" /></label>
        <small>No keys are saved to disk or passed to the modeling backend. API-key providers only in this preview.</small>
        <h2>Native OpenStudio MCP</h2>
        <p>This preview does not bundle OpenStudio. Supply an installed MCP executable, its Python/SDK dependencies, and Measure assets.</p>
        <label>Project folder<input readOnly value={config.workspace} placeholder="Choose a project folder in the sidebar" /></label>
        <label>MCP executable (absolute path)<input disabled={connected || connecting} value={config.backend.command}
          onChange={(e) => setConfig((c) => ({ ...c, backend: { ...c.backend, command: e.target.value } }))}
          placeholder="/absolute/path/to/venv/bin/openstudio-mcp" /></label>
        <label>Arguments (JSON array)<input disabled={connected || connecting} value={argsText} onChange={(e) => setArgsText(e.target.value)} /></label>
        <label>Read-only dependency folders (one absolute path per line)<textarea disabled={connected || connecting} value={rootsText}
          onChange={(e) => setRootsText(e.target.value)} placeholder="Python runtime, SDK installation, MCP source, Measures and skills folders" /></label>
        <label>Runtime environment (JSON object)<textarea disabled={connected || connecting} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
        <small>Network is denied. Downloads and remote analysis are not available. Never put secrets in runtime settings.</small>
        <div className="row actions">
          <button className="primary" disabled={busy || connecting || connected} onClick={() => void connect()}>{connecting ? "Starting sandbox..." : "Connect sandboxed backend"}</button>
          <button disabled={busy || connecting || !connected} onClick={() => void run(() => window.chatstudio.disconnect())}>Disconnect</button>
          <button disabled={busy || connecting || !apiKey || !selectedModel} onClick={() => void run(async () => {
            await saveSettings(); setSettings(false);
          })}>Open chat</button>
        </div>
      </section> : <>
        <section className="conversation">
          {!messages.length && <div className="welcome"><div className="eyebrow">YOUR BUILDING. A CLEARER PICTURE.</div>
            <h1>What would you like<br />to explore?</h1>
            <p>Create, inspect, and improve building energy models<br />with native OpenStudio tools and a conversational guide.</p>
            <div className="suggestions">{["Summarize my building model", "Help me choose an HVAC system", "Explain simulation warnings"].map((text) =>
              <button key={text} onClick={() => setInput(text)}>{text}<span>↗</span></button>)}</div>
          </div>}
          {messages.map((m, i) => <article key={i} className={`message ${m.role}`}><div className="speaker">{m.role === "user" ? "You" : "ChatStudio"}</div>
            <div className="message-text">{m.text || (busy ? "Thinking..." : "No text returned. Check diagnostics above.")}</div></article>)}
          {approval && <div className="approval" role="dialog" aria-label="Approve tool execution"><strong>Allow {approval.name}?</strong>
            <p>Runs inside the configured OS sandbox. Review the arguments before approving.</p><pre>{approval.arguments}</pre>
            <button className="primary" onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, true); setApproval(null); })}>Allow once</button>
            <button onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, true, true); setApproval(null); })}>Allow this tool for this session</button>
            <button onClick={() => void run(async () => { await window.chatstudio.approve(approval.id, false); setApproval(null); })}>Deny</button>
            <p>Session permission allows this tool with any arguments until revoked or the conversation/backend changes.</p>
          </div>}
          <div ref={end} />
        </section>
        <footer><form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea aria-label="Message" value={input} disabled={busy} maxLength={32000} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder="Ask about your building..." />
          {busy ? <button type="button" onClick={() => void run(() => window.chatstudio.abort())}>Stop</button>
            : <button className="primary" disabled={!input.trim() || !apiKey || !selectedModel}>Send</button>}
        </form><small>{connected ? status : "Chat is available. Connect a native backend in Settings to use modeling tools."}</small></footer>
      </>}
    </main>
  </div>;
}
