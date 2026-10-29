import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function patchWindowsStdio(directory) {
  const replace = async (name, before, after) => {
    const file = path.join(directory, "src", name);
    const source = await readFile(file, "utf8");
    if (source.split(before).length !== 2) throw new Error(`Unexpected pinned sandbox source: ${name}`);
    await writeFile(file, source.replace(before, after));
  };
  await replace("runner.rs", "let mut stdin = std::io::stdin().lock();", `// Read exactly the control frame: a buffered Stdin would consume application input.
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    let handle = std::io::stdin().as_raw_handle();
    let mut stdin = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle) });`);
  await replace("logon.rs", "    drop(stdin.broker);", `    if matches!(cmd, crate::runner::RunnerCmd::Exec(_)) {
        let input = std::os::windows::io::AsRawHandle::as_raw_handle(&std::io::stdin()) as isize;
        let target = stdin.broker.into_raw().0 as isize;
        // Do not join: a server may exit while its caller still holds stdin open.
        // Process exit ends any blocked read; the worker owns the pipe's write end.
        std::thread::spawn(move || {
            let src = HANDLE(input as *mut c_void);
            let dst = HANDLE(target as *mut c_void);
            pump(src, dst);
            unsafe { let _ = CloseHandle(dst); }
        });
    } else {
        drop(stdin.broker);
    }`);
}

export async function patchWindowsEventLoop(stdlib) {
  const file = path.join(stdlib, "asyncio/proactor_events.py");
  let source = await readFile(file, "utf8");
  const before = `        self._ssock, self._csock = socket.socketpair()
        self._ssock.setblocking(False)
        self._csock.setblocking(False)`;
  const after = `        # ChatStudio: internal wakeups must not require TCP loopback access.
        from chatstudio_windows_self_pipe import pipe_pair
        self._ssock, self._csock = pipe_pair()`;
  if (!source.includes(after)) {
    if (source.split(before).length !== 2) throw new Error("Unexpected pinned CPython proactor source");
    source = source.replace(before, after);
  }
  const signalBefore = "if threading.current_thread() is threading.main_thread():";
  const signalAfter = "if threading.current_thread() is threading.main_thread() and isinstance(self._csock, socket.socket):";
  if (!source.includes(signalAfter)) {
    if (source.split(signalBefore).length !== 3) throw new Error("Unexpected pinned CPython signal-wakeup source");
    source = source.replaceAll(signalBefore, signalAfter);
  }
  await writeFile(file, source);
}

export async function patchWindowsMeasureSyntax(sitePackages) {
  const file = path.join(sitePackages, "mcp_server/skills/measure_authoring/operations.py");
  let source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  const replacements = [
    ["import subprocess\n", "import subprocess\nimport os\nimport sys\n"],
    ['["ruby", "-c", str(script_path)],',
      '[os.environ["OPENSTUDIO_CLI"], str(Path(os.environ["OPENSTUDIO_CLI"]).parents[2] / "ruby-driver.rb"), "-c", str(script_path)],'],
    ['["python3", "-c", f"compile({code!r}, {str(script_path)!r}, \'exec\')"],',
      '[sys.executable, "-I", "-X", "utf8", "-c", f"compile({code!r}, {str(script_path)!r}, \'exec\')"],'],
    ['["openstudio", "measure", "-u", str(staged_measure)]',
      '["openstudio", "classic", "measure", "-u", str(staged_measure)]'],
  ];
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error(`Unexpected pinned MCP Measure syntax source: ${before}`);
    source = source.replaceAll(before, after);
  }
  await writeFile(file, source);
}

export async function patchWindowsMcpChildren(sitePackages) {
  const directory = path.join(sitePackages, "mcp_server");
  const subprocessSites = [
    ["skills/measure_authoring/operations.py", "run", 5],
    ["skills/measures/operations.py", "run", 1],
    ["skills/simulation/operations.py", "Popen", 1],
    ["skills/gbxml_import/operations.py", "run", 1],
    ["skills/python_ems/actuators.py", "run", 1],
    ["skills/python_ems/packages.py", "run", 2],
    ["skills/server_info/operations.py", "check_output", 1],
  ];
  for (const [name, method, count] of subprocessSites) {
    const file = path.join(directory, name);
    let source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
    const before = `subprocess.${method}(`;
    const after = `${before}stdin=subprocess.DEVNULL, args=`;
    if (source.split(after).length === count + 1) continue;
    if (source.split(before).length !== count + 1) throw new Error(`Unexpected pinned MCP subprocess source: ${name}`);
    source = source.replaceAll(before, after);
    await writeFile(file, source);
  }
  const file = path.join(directory, "sandbox.py");
  let source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  const replacements = [
    ['"PATH", "HOME", "USER",', '"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "HOME", "USER",'],
    ['            env["TMPDIR"] = str(tmp)',
      '            env["TMPDIR"] = str(tmp)\n            if os.name == "nt":\n                env["TEMP"] = env["TMP"] = str(tmp)'],
    ["    return env\n", `    if os.name == "nt":
        home = Path(work_dir).resolve()
        env["HOME"] = env["USERPROFILE"] = str(home)
        env["HOMEDRIVE"] = home.drive
        env["HOMEPATH"] = str(home)[len(home.drive):]
        for key, name in (("APPDATA", "Roaming"), ("LOCALAPPDATA", "Local")):
            directory = home / "AppData" / name
            directory.mkdir(parents=True, exist_ok=True)
            env[key] = str(directory)
        common = home / "ProgramData"
        common.mkdir(exist_ok=True)
        env["PROGRAMDATA"] = env["ALLUSERSPROFILE"] = str(common)
        env["WINDIR"] = env["SYSTEMROOT"]
        env["SYSTEMDRIVE"] = Path(env["SYSTEMROOT"]).drive
    return env
`],
  ];
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error("Unexpected pinned MCP Windows environment source");
    source = source.replace(before, after);
  }
  await writeFile(file, source);
}
