import os
from pathlib import Path
import signal
import subprocess
import tempfile
from typing import Literal


def register_script_tool(mcp, root):
    @mcp.tool(name="run_sandboxed_script")
    def run_sandboxed_script(language: Literal["Python", "Ruby"], code: str,
                             timeout_seconds: int = 60) -> dict:
        """Run Python or Ruby code inside ChatStudio's OS sandbox in the current
        project. Requires normal tool approval. Python includes the OpenStudio
        SDK; Ruby uses the OpenStudio CLI's embedded Ruby and bundled gems.
        Scripts may modify project files. Output is bounded; nonzero exit codes
        and timeouts are errors. Never use this to bypass a denied operation."""
        if not code.strip() or len(code.encode("utf-8")) > 256 * 1024:
            raise ValueError("Script must contain between 1 and 262144 UTF-8 bytes.")
        if isinstance(timeout_seconds, bool) or not 1 <= timeout_seconds <= 90:
            raise ValueError("Script timeout must be between 1 and 90 seconds.")
        workspace = Path(os.environ["OPENSTUDIO_MCP_RUN_ROOT"]).resolve().parent
        suffix = ".py" if language == "Python" else ".rb"
        executable = root / ("python-runtime/python.exe" if os.name == "nt"
                             else "python-runtime/bin/python3")
        with tempfile.TemporaryDirectory(prefix="script-", dir=workspace / "tmp") as directory:
            source = Path(directory) / ("script" + suffix)
            source.write_text(code, encoding="utf-8")
            command = [str(executable), "-I", "-X", "utf8", str(source)] if language == "Python" else [
                str(root / ("openstudio/bin/openstudio.exe" if os.name == "nt"
                            else "openstudio/bin/openstudio")),
                str(root / "ruby-driver.rb"), str(source)]
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                child = subprocess.Popen(command, cwd=workspace, stdin=subprocess.DEVNULL,
                                         stdout=stdout, stderr=stderr,
                                         start_new_session=os.name != "nt")
                try:
                    child.wait(timeout=timeout_seconds)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"),
                                        "/PID", str(child.pid), "/T", "/F"],
                                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise TimeoutError(f"{language} script exceeded {timeout_seconds} seconds.")
                stdout.seek(0)
                stderr.seek(0)
                out = stdout.read(65537)
                err = stderr.read(65537)
                result = {"language": language, "exit_code": child.returncode,
                          "stdout": out[:65536].decode("utf-8", errors="replace"),
                          "stderr": err[:65536].decode("utf-8", errors="replace"),
                          "truncated": len(out) > 65536 or len(err) > 65536}
                if child.returncode != 0:
                    raise RuntimeError(f"{language} script exited {child.returncode}: {result}")
                return result
