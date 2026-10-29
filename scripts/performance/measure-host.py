#!/usr/bin/env python3
"""Read-only Linux process/host sampler; does not connect or stop any accounts.

Run on the actual host (not the development Mac or inside a container):
  sudo python3 scripts/performance/measure-host.py --duration 600 --output /tmp/afk-idle.json
CPU 100% means one logical core. Process counts are NOT verified online accounts.
Only classified process metrics are exported; no command lines, names or tokens.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import platform
import signal
import statistics
import time

GROUPS = ("java", "bedrock", "backend", "backend-helper", "web", "tunnel")
MIB = 1024 ** 2


def distribution(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return {"mean": statistics.mean(values), "p95": values[math.ceil(len(values) * .95) - 1],
            "max": values[-1], "samples": len(values)}


def summarize(samples, metric):
    result = distribution([sample[metric] for sample in samples])
    if result and metric == "cpu_percent_one_core":
        valid = [s for s in samples if s[metric] is not None and s["interval_seconds"] > 0]
        if valid:
            result["mean"] = sum(s[metric] * s["interval_seconds"] for s in valid) / sum(s["interval_seconds"] for s in valid)
    return result


def parse_stat(text, ticks, page_size):
    # comm may contain spaces and parentheses. Fields after the last ')' are stable.
    fields = text[text.rindex(")") + 2:].split()
    return {"ppid": int(fields[1]), "cpu_seconds": (int(fields[11]) + int(fields[12])) / ticks,
            "start_ticks": int(fields[19]), "rss_bytes": int(fields[21]) * page_size,
            "threads": int(fields[17])}


def classify(argv):
    if not argv:
        return None
    executable = Path(argv[0]).name
    args = [arg.replace("\\", "/") for arg in argv[1:]]
    if executable == "azalea-bot":
        return "java"
    if executable in ("node", "nodejs"):
        if any(arg.endswith(("/bedrock-bot/index.js", "/bedrock-bot/index.ts")) for arg in args):
            return "bedrock"
        if any(arg in ("dist/server.js", "src/server.ts", "/app/dist/server.js") or
               arg.endswith("/backend/dist/server.js") for arg in args):
            return "backend"
    return {"caddy": "web", "cloudflared": "tunnel"}.get(executable)


def process_cpu(current, previous, elapsed):
    if previous is None or previous["start_ticks"] != current["start_ticks"] or elapsed <= 0:
        return None
    return max(0, current["cpu_seconds"] - previous["cpu_seconds"]) / elapsed * 100


def memory_info(text):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        # smaps_rollup starts with a mapping header containing '00:00'.
        if len(fields) >= 2 and fields[0].endswith(":") and fields[1].isdigit():
            values[fields[0][:-1]] = int(fields[1]) * 1024
    return values


def scan_processes(proc, ticks, page_size, backend_pid):
    processes, classified = {}, {}
    for directory in proc.iterdir():
        if not directory.name.isdigit() or int(directory.name) == os.getpid():
            continue
        try:
            pid = int(directory.name)
            metric = parse_stat((directory / "stat").read_text(), ticks, page_size)
            argv = (directory / "cmdline").read_bytes().decode("utf8", "replace").rstrip("\0").split("\0")
            group = "backend" if pid == backend_pid else classify(argv)
            processes[pid] = metric
            if group:
                classified[pid] = group
        except (OSError, ValueError, IndexError):
            continue  # Process exited or cannot be inspected.
    if backend_pid:
        # Other independent website stacks are outside this explicit scope.
        classified = {pid: group for pid, group in classified.items()
                      if group in ("web", "tunnel") or pid == backend_pid}
    changed = True
    while changed:
        changed = False
        for pid, metric in processes.items():
            parent_group = classified.get(metric["ppid"])
            if parent_group and pid not in classified:
                # Detect bot processes in the selected backend's subtree too.
                directory = proc / str(pid)
                try:
                    argv = (directory / "cmdline").read_bytes().decode("utf8", "replace").rstrip("\0").split("\0")
                except OSError:
                    argv = []
                classified[pid] = classify(argv) or ("backend-helper" if parent_group == "backend" else parent_group)
                changed = True
    result = {}
    for pid, group in classified.items():
        metric = processes[pid]
        pss = None
        try:
            rollup = memory_info((proc / str(pid) / "smaps_rollup").read_text())
            pss = rollup.get("Pss")
        except (OSError, ValueError):
            pass
        result[pid] = {**metric, "group": group, "pss_bytes": pss}
    return result


def host_sample(proc):
    memory = memory_info((proc / "meminfo").read_text())
    cpu = [int(value) for value in (proc / "stat").read_text().splitlines()[0].split()[1:9]]
    network = {}
    for line in (proc / "net/dev").read_text().splitlines()[2:]:
        name, counters = line.split(":", 1)
        fields = counters.split()
        network[name.strip()] = {"rx_bytes": int(fields[0]), "tx_bytes": int(fields[8])}
    available = memory.get("MemAvailable")
    return {"cpu_counters": cpu, "mem_total_mib": memory["MemTotal"] / MIB,
            "mem_available_mib": available / MIB if available is not None else None,
            "mem_used_mib": (memory["MemTotal"] - available) / MIB if available is not None else None,
            "swap_used_mib": (memory["SwapTotal"] - memory["SwapFree"]) / MIB,
            "load_average": list(os.getloadavg()), "network": network}


def grouped(processes):
    result = {}
    for group in GROUPS:
        members = [p for p in processes.values() if p["group"] == group]
        cpu_values = [p["cpu_percent_one_core"] for p in members if p["cpu_percent_one_core"] is not None]
        result[group] = {"processes": len(members),
                         "rss_mib": sum(p["rss_bytes"] for p in members) / MIB,
                         "pss_mib": sum(p["pss_bytes"] for p in members) / MIB
                         if all(p["pss_bytes"] is not None for p in members) else None,
                         "cpu_percent_one_core": sum(cpu_values) if len(cpu_values) == len(members) else None,
                         "threads": sum(p["threads"] for p in members)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--duration", type=float, default=600, help="Seconds (default: 600)")
    parser.add_argument("--interval", type=float, default=2, help="Sample interval in seconds")
    parser.add_argument("--backend-pid", type=int, help="Scope bots/helpers to this backend host PID")
    parser.add_argument("--label", default="existing-live-workload")
    parser.add_argument("--output", required=True, help="New JSON file (never overwrites an existing file)")
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Run this sampler on the Linux host that actually runs the bots.")
    if not math.isfinite(args.duration) or not math.isfinite(args.interval) or args.interval < .5 or args.duration < args.interval:
        parser.error("Use finite duration >= interval >= 0.5 seconds.")
    if Path(args.output).exists():
        parser.error("Output already exists; choose a new file.")
    proc = Path("/proc")
    ticks, page_size = os.sysconf("SC_CLK_TCK"), os.sysconf("SC_PAGE_SIZE")
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    samples, per_process, previous = [], {}, {}
    begin = last = time.monotonic()
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    previous_host = None
    print("Sampling existing processes; no accounts are connected, stopped or reconfigured.", flush=True)
    while True:
        now = time.monotonic()
        elapsed = now - last
        current = scan_processes(proc, ticks, page_size, args.backend_pid)
        for pid, metric in current.items():
            metric["cpu_percent_one_core"] = process_cpu(metric, previous.get(pid), elapsed)
            key = "%s:%s" % (pid, metric["start_ticks"])
            entry = per_process.setdefault(key, {"pid": pid, "group": metric["group"], "samples": []})
            entry["samples"].append({"at_seconds": now - begin, "rss_mib": metric["rss_bytes"] / MIB,
                                     "interval_seconds": elapsed,
                                     "pss_mib": metric["pss_bytes"] / MIB if metric["pss_bytes"] is not None else None,
                                     "cpu_percent_one_core": metric["cpu_percent_one_core"], "threads": metric["threads"]})
        host = host_sample(proc)
        if previous_host:
            delta = [a - b for a, b in zip(host["cpu_counters"], previous_host["cpu_counters"])]
            total = sum(delta)
            if total > 0:
                host.update({"cpu_busy_percent_host": (total - delta[3] - delta[4] - delta[7]) / total * 100,
                             "cpu_iowait_percent_host": delta[4] / total * 100,
                             "cpu_steal_percent_host": delta[7] / total * 100})
            for name, values in host["network"].items():
                old = previous_host["network"].get(name)
                if old and elapsed > 0:
                    values.update({"rx_bytes_per_second": max(0, values["rx_bytes"] - old["rx_bytes"]) / elapsed,
                                   "tx_bytes_per_second": max(0, values["tx_bytes"] - old["tx_bytes"]) / elapsed})
        samples.append({"at_seconds": now - begin, "interval_seconds": elapsed,
                        "host": host, "groups": grouped(current)})
        previous, previous_host, last = current, host, now
        if stopped or now - begin >= args.duration:
            break
        time.sleep(min(max(0, args.interval - (time.monotonic() - now)), max(0, args.duration - (time.monotonic() - begin))))
    summaries = {group: {metric: summarize([{**sample["groups"][group], "interval_seconds": sample["interval_seconds"]}
                                          for sample in samples], metric)
                         for metric in ("processes", "rss_mib", "pss_mib", "cpu_percent_one_core", "threads")}
                 for group in GROUPS}
    for entry in per_process.values():
        entry["summary"] = {metric: summarize(entry["samples"], metric)
                            for metric in ("rss_mib", "pss_mib", "cpu_percent_one_core", "threads")}
    temperatures = {}
    for sensor in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            temperatures[sensor.parent.name] = int(sensor.read_text()) / 1000
        except (OSError, ValueError):
            pass
    cpu_info = (proc / "cpuinfo").read_text()
    model = next((line.split(":", 1)[1].strip() for line in cpu_info.splitlines()
                  if line.split(":", 1)[0].strip() in ("Model", "model name", "Hardware")), None)
    report = {"started_at": started, "duration_seconds": time.monotonic() - begin, "label": args.label,
              "machine": {"system": platform.system(), "architecture": platform.machine(), "kernel": platform.release(),
                          "cpu_or_board": model,
                          "logical_cpus": os.cpu_count(), "inside_docker": Path("/.dockerenv").exists(),
                          "final_temperature_celsius": temperatures},
              "limitations": ["Process counts are not verified ONLINE accounts; confirm in the dashboard.",
                              "CPU 100% is one logical core; host CPU percentages cover the whole machine.",
                              "RSS double-counts shared pages; prefer PSS for memory capacity planning.",
                              "Unreadable PSS is null, never silently replaced by RSS.",
                              "Exited processes can lose their last partial interval; short-lived peaks may be missed.",
                              "Network counters are per interface; summing virtual interfaces double-counts traffic.",
                              "Run on host for host-wide figures; container namespaces can hide sibling services.",
                              "CPU results cannot be transferred directly to another CPU or shared cloud plan."],
              "summary": summaries, "processes": list(per_process.values()), "samples": samples}
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    for group, summary in summaries.items():
        count = summary["processes"]["max"]
        if count:
            cpu = summary["cpu_percent_one_core"]
            pss = summary["pss_mib"]
            print("%s: max %s processes; mean CPU %s%% of one core; max total PSS %s MiB; max total RSS %.1f MiB" % (
                group, count, "%.2f" % cpu["mean"] if cpu else "unavailable",
                "%.1f" % pss["max"] if pss else "unavailable", summary["rss_mib"]["max"]))
    print("Report:", args.output)


if __name__ == "__main__":
    main()
