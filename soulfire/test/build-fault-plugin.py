#!/usr/bin/env python3
"""Build an isolated fault-injection plugin, never a production deployment jar.
Pass the regular build-plugin.py arguments, including a distinct --output.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="afk-cleanup-fault-build-") as temporary:
    root = Path(temporary)
    shutil.copy2(source / "build-plugin.py", root / "build-plugin.py")
    shutil.copytree(source / "plugin", root / "plugin")
    shutil.copy2(source / "test/fixtures/DisconnectFaultMixin.java", root / "plugin/src/de/afkservice/mixin/DisconnectFaultMixin.java")
    config = root / "plugin/afk-service.mixins.json"
    value = json.loads(config.read_text())
    value["mixins"].append("DisconnectFaultMixin")
    config.write_text(json.dumps(value))
    subprocess.run([sys.executable, str(root / "build-plugin.py"), *sys.argv[1:]], check=True)
