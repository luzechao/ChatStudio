import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
command = sys.argv.pop(1)
python = root / ("python-runtime/python.exe" if os.name == "nt" else "python-runtime/bin/python3")
cli = root / ("openstudio/bin/openstudio.exe" if os.name == "nt" else "openstudio/bin/openstudio")
if command == "openstudio-mcp":
    sys.argv[0] = "openstudio-mcp"
    from mcp_server.server import main
    main()
elif command == "python3":
    os.execv(str(python), [str(python), *sys.argv[1:]])
elif command == "ruby":
    os.execv(str(cli), [str(cli), str(root / "ruby-driver.rb"), *sys.argv[1:]])
else:
    raise SystemExit(f"Unsupported bundled command: {command}")
