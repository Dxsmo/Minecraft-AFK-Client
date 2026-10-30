#!/usr/bin/env python3
"""Build against the exact, checksum-pinned release's embedded API and client.
No mutable Maven snapshots, Gradle remapping or separately installed MC needed.
Minecraft 26.3 ships unobfuscated classes, matching SoulFire's native names.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile
import json

VERSION = "2.10.6"
SHA256 = "f033a3c1a88b6f3d303a4d9baee926cc8c3712069dcf30bcb631d368b25e5454"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--soulfire-jar", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", default="build/plugin-deps")
    args = parser.parse_args()
    jar = Path(args.soulfire_jar)
    if hashlib.sha256(jar.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("SoulFire release checksum mismatch")
    cache = Path(args.cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    libraries = []
    with zipfile.ZipFile(jar) as release:
        manifest = json.loads(release.read("META-INF/soulfire-assets.json"))
        for asset in manifest["assets"]:
            if not asset["path"].endswith(".jar"):
                continue
            if "resource" not in asset and not asset["name"].startswith(("org.ow2.asm:", "com.mojang:brigadier:")) and asset["name"] not in ["Minecraft client", "net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7", "com.google.code.gson:gson:2.14.0", "net.lenni0451:LambdaEvents:2.4.2", "org.jspecify:jspecify:1.0.1", "it.unimi.dsi:fastutil:8.5.19"]:
                continue
            target = cache / (asset["sha256"] + ".jar")
            if not target.exists():
                if "resource" in asset:
                    target.write_bytes(release.read(asset["resource"]))
                else:
                    urllib.request.urlretrieve(asset["url"], target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != asset["sha256"]:
                target.unlink()
                raise SystemExit("Dependency checksum mismatch: " + asset["name"])
            libraries.append(str(target))
    root = Path(__file__).resolve().parent / "plugin"
    classes = cache / "classes"
    shutil.rmtree(classes, ignore_errors=True)
    classes.mkdir()
    java_home = os.environ.get("JAVA_HOME")
    javac = str(Path(java_home) / "bin/javac") if java_home else "javac"
    subprocess.run([javac, "--release", "25", "-proc:none", "-cp", os.pathsep.join(libraries), "-d", str(classes), *map(str, root.glob("src/**/*.java"))], check=True)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as plugin:
        for resource in root.glob("*.json"):
            plugin.write(resource, resource.name)
        for file in classes.rglob("*.class"):
            plugin.write(file, file.relative_to(classes).as_posix())
    print("Built", output)


if __name__ == "__main__":
    main()
