#!/usr/bin/env python3
"""Build an isolated runtime probe; never install this JAR on the production Pi."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parents[1]
args = sys.argv[1:]
without_buffer = "--without-buffer" in args
if without_buffer:
    args.remove("--without-buffer")
without_ambient = "--without-ambient" in args
if without_ambient:
    args.remove("--without-ambient")
without_sky = "--without-sky" in args
if without_sky:
    args.remove("--without-sky")
without_udp = "--without-udp" in args
if without_udp:
    args.remove("--without-udp")
without_timeline = "--without-timeline" in args
if without_timeline:
    args.remove("--without-timeline")
without_isolation = "--without-isolation" in args
if without_isolation:
    args.remove("--without-isolation")
without_world = "--without-world-isolation" in args
if without_world:
    args.remove("--without-world-isolation")
with tempfile.TemporaryDirectory(prefix="afk-runtime-probe-") as directory:
    root = Path(directory)
    shutil.copytree(source / "plugin", root / "plugin")
    shutil.copy2(source / "build-plugin.py", root / "build-plugin.py")
    for name, destination in [("RuntimeProbe.java", "plugin/src/de/afkservice/RuntimeProbe.java"),
                              ("TimelineRace.java", "plugin/src/de/afkservice/TimelineRace.java"),
                              ("BedrockIsolationProbe.java", "plugin/src/de/afkservice/BedrockIsolationProbe.java"),
                              ("AmbientProbeMixin.java", "plugin/src/de/afkservice/mixin/AmbientProbeMixin.java")]:
        shutil.copy2(source / "test/fixtures" / name, root / destination)
    if without_world:
        marker = root / "plugin/src/de/afkservice/mixin/BedrockClientStateMixin.java"
        marker.write_text(marker.read_text().replace('  "com.viaversion.viafabricplus.bedrock.appearance.BedrockNativeBlocks",\n', ''))
    fabric = root / "plugin/fabric.mod.json"
    data = json.loads(fabric.read_text())
    data["entrypoints"]["main"].append("de.afkservice.RuntimeProbe")
    fabric.write_text(json.dumps(data))
    mixins = root / "plugin/afk-service.mixins.json"
    data = json.loads(mixins.read_text())
    data["mixins"].append("AmbientProbeMixin")
    if without_ambient:
        data["mixins"].remove("HeadlessAmbientMixin")
    if without_buffer:
        data["mixins"].remove("BedrockWorldBufferMixin")
    if without_sky:
        data["mixins"].remove("HeadlessSkyTextureMixin")
    if without_isolation:
        data["mixins"].remove("BedrockClientStateMixin")
    if without_timeline:
        data["mixins"].remove("BedrockMovementTimelineMixin")
    if without_udp:
        data["mixins"].remove("BedrockReceiveBufferMixin")
    mixins.write_text(json.dumps(data))
    subprocess.run([sys.executable, str(root / "build-plugin.py"), *args], check=True)
