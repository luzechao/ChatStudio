import os
from pathlib import Path
import sys
import subprocess

root = Path(__file__).resolve().parent
command = sys.argv.pop(1)
python = root / ("python-runtime/python.exe" if os.name == "nt" else "python-runtime/bin/python3")
cli = root / ("openstudio/bin/openstudio.exe" if os.name == "nt" else "openstudio/bin/openstudio")

def execute(executable, arguments):
    argv = [str(executable), *arguments]
    if os.name == "nt":
        raise SystemExit(subprocess.run(argv, check=False).returncode)
    os.execv(str(executable), argv)

if command == "openstudio-mcp":
    sys.argv[0] = "openstudio-mcp"
    import runpy
    if sys.argv[1:] == ["--chatstudio-startup-trace"]:
        import faulthandler
        import time
        sys.argv.pop()
        faulthandler.dump_traceback_later(20, repeat=True)
        print(f"[ChatStudio] Startup trace enabled at {time.monotonic():.3f}.", file=sys.stderr, flush=True)
        if os.name == "nt":
            import ctypes
            import shutil
            def trace_child(event, arguments):
                if event == "subprocess.Popen":
                    executable, argv, cwd, environment = arguments
                    buffer = ctypes.create_unicode_buffer(32768)
                    ctypes.windll.kernel32.GetEnvironmentVariableW("PATH", buffer, len(buffer))
                    print(f"[ChatStudio] Child executable={executable!r}, resolved={shutil.which(executable)!r}, cwd={cwd!r}, "
                          f"python_PATH={os.environ.get('PATH')!r}, native_PATH={buffer.value!r}, explicit_env={environment is not None}.",
                          file=sys.stderr, flush=True)
            sys.addaudithook(trace_child)
    if os.name == "nt":
        print("[ChatStudio] Loading native Python MCP modules.", file=sys.stderr, flush=True)
    from mcp_server.server import main, mcp
    runpy.run_path(str(root / "script-tool.py"))["register_script_tool"](mcp, root)
    if os.name == "nt":
        import time
        print(f"[ChatStudio] Starting native MCP stdio server at {time.monotonic():.3f}.", file=sys.stderr, flush=True)
    main()
elif command == "python3":
    execute(python, sys.argv[1:])
elif command == "ruby":
    execute(cli, [str(root / "ruby-driver.rb"), *sys.argv[1:]])
else:
    raise SystemExit(f"Unsupported bundled command: {command}")
