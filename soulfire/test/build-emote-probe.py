#!/usr/bin/env python3
"""Build a synthetic emote memory probe; never deploy this jar to production.
Use --without-fix for the negative control. Other arguments go to build-plugin.py.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--without-fix', action='store_true')
options, build_args = parser.parse_known_args()
source = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='afk-emote-probe-') as temporary:
    root = Path(temporary)
    shutil.copy2(source / 'build-plugin.py', root / 'build-plugin.py')
    shutil.copytree(source / 'plugin', root / 'plugin')
    shutil.copy2(source / 'test/fixtures/EmoteLeakProbe.java', root / 'plugin/src/de/afkservice/EmoteLeakProbe.java')
    config = root / 'plugin/fabric.mod.json'
    value = json.loads(config.read_text())
    value['entrypoints']['main'].append('de.afkservice.EmoteLeakProbe')
    config.write_text(json.dumps(value))
    if options.without_fix:
        config = root / 'plugin/afk-service.mixins.json'
        value = json.loads(config.read_text())
        value['mixins'].remove('HeadlessEmoteMixin')
        config.write_text(json.dumps(value))
    subprocess.run([sys.executable, str(root / 'build-plugin.py'), *build_args], check=True)
