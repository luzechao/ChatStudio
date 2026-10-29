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
    from mcp_server.server import main, mcp
    runpy.run_path(str(root / "script-tool.py"))["register_script_tool"](mcp, root)
    main()
elif command == "python3":
    execute(python, sys.argv[1:])
elif command == "ruby":
    execute(cli, [str(root / "ruby-driver.rb"), *sys.argv[1:]])
else:
    raise SystemExit(f"Unsupported bundled command: {command}")
