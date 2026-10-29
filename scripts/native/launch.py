import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
command = sys.argv.pop(1)
if command == "openstudio-mcp":
    sys.argv[0] = "openstudio-mcp"
    from mcp_server.server import main
    main()
elif command == "python3":
    os.execv(str(root / "python-runtime/bin/python3"), ["python3", *sys.argv[1:]])
elif command == "ruby":
    os.execv(str(root / "openstudio/bin/openstudio"),
             ["openstudio", str(root / "ruby-driver.rb"), *sys.argv[1:]])
else:
    raise SystemExit(f"Unsupported bundled command: {command}")
