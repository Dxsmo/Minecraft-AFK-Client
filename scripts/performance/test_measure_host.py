import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
import contextlib
import io
import json

spec = importlib.util.spec_from_file_location("measure_host", Path(__file__).with_name("measure-host.py"))
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


class MetricsTest(unittest.TestCase):
    def test_proc_stat_fields_and_names_with_spaces_and_parentheses(self):
        fields = ["S"] + ["0"] * 49
        for index, value in {1: "12", 11: "150", 12: "50", 17: "4", 19: "7654", 21: "100"}.items():
            fields[index] = value
        result = sampler.parse_stat("42 (name (with) spaces) " + " ".join(fields), 100, 4096)
        self.assertEqual(result, {"ppid": 12, "cpu_seconds": 2, "start_ticks": 7654,
                                  "rss_bytes": 409600, "threads": 4})

    def test_cpu_is_interval_based_and_pid_reuse_is_not_a_new_peak(self):
        previous = {"start_ticks": 1, "cpu_seconds": 20}
        current = {"start_ticks": 1, "cpu_seconds": 23}
        self.assertEqual(sampler.process_cpu(current, previous, 2), 150)
        self.assertIsNone(sampler.process_cpu({**current, "start_ticks": 2}, previous, 2))
        self.assertIsNone(sampler.process_cpu(current, None, 2))

    def test_classification_never_needs_account_tokens_or_names(self):
        self.assertEqual(sampler.classify(["/app/azalea-bot"]), "java")
        self.assertEqual(sampler.classify(["/opt/java/bin/java", "-Xmx4g", "-jar", "/opt/soulfire/SoulFireDedicated.jar"]), "soulfire")
        self.assertIsNone(sampler.classify(["java", "-jar", "/opt/other-service.jar"]))
        self.assertEqual(sampler.classify(["node", "dist/bedrock-bot/index.js"]), "bedrock")
        self.assertEqual(sampler.classify(["node", "--enable-source-maps", "/app/dist/server.js"]), "backend")
        self.assertIsNone(sampler.classify(["node", "some-other-application.js"]))

    def test_group_does_not_hide_unreadable_pss_or_incomplete_cpu(self):
        metric = {"group": "java", "rss_bytes": sampler.MIB, "pss_bytes": sampler.MIB // 2,
                  "cpu_percent_one_core": 10, "threads": 2}
        groups = sampler.grouped({1: metric, 2: {**metric, "pss_bytes": None, "cpu_percent_one_core": None}})
        self.assertEqual(groups["java"]["rss_mib"], 2)
        self.assertIsNone(groups["java"]["pss_mib"])
        self.assertIsNone(groups["java"]["cpu_percent_one_core"])
        self.assertEqual(groups["bedrock"]["processes"], 0)

    def test_p95_and_missing_data(self):
        self.assertEqual(sampler.distribution(list(range(1, 101)) + [None])["p95"], 95)
        self.assertIsNone(sampler.distribution([None]))

    def test_smaps_rollup_header_does_not_hide_pss(self):
        text = '00400000-00700000 ---p 00000000 00:00 0 [rollup]\nRss: 200 kB\nPss: 125 kB\n'
        self.assertEqual(sampler.memory_info(text), {"Rss": 204800, "Pss": 128000})

    def test_cpu_mean_weights_short_final_intervals(self):
        result = sampler.summarize([
            {"cpu_percent_one_core": 10, "interval_seconds": 2},
            {"cpu_percent_one_core": 90, "interval_seconds": .5},
        ], "cpu_percent_one_core")
        self.assertEqual(result['mean'], 26)

    def test_explicit_backend_scope_keeps_its_bots_and_helpers_only(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root)
            for pid, parent, argv in [(101, 1, ['node', '/app/dist/server.js']),
                                      (102, 101, ['/app/azalea-bot']),
                                      (103, 101, ['node', 'dist/bedrock-bot/index.js']),
                                      (104, 101, ['helper']),
                                      (201, 1, ['node', '/app/dist/server.js']),
                                      (202, 201, ['/app/azalea-bot'])]:
                directory = proc / str(pid)
                directory.mkdir()
                fields = ['S'] + ['0'] * 49
                fields[1], fields[19], fields[21] = str(parent), str(pid), '10'
                (directory / 'stat').write_text(str(pid) + ' (process) ' + ' '.join(fields))
                (directory / 'cmdline').write_bytes(('\0'.join(argv) + '\0').encode())
                (directory / 'smaps_rollup').write_text('00400000-00700000 ---p 00000000 00:00 0 [rollup]\nPss: 125 kB\n')
            result = sampler.scan_processes(proc, 100, 4096, 101)
            self.assertEqual({pid: value['group'] for pid, value in result.items()},
                             {101: 'backend', 102: 'java', 103: 'bedrock', 104: 'backend-helper'})
            self.assertEqual(result[102]['pss_bytes'], 128000)

    def test_complete_sampling_with_linux_fixtures_exports_no_command_lines(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root) / 'proc'
            (proc / 'net').mkdir(parents=True)
            (proc / 'meminfo').write_text('MemTotal: 8192000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')
            (proc / 'cpuinfo').write_text('model name : Fixture CPU\n')
            (proc / 'stat').write_text('cpu  10 0 10 100 0 0 0 0 0 0\n')
            (proc / 'net/dev').write_text('header\nheader\neth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n')
            process = proc / '101'
            process.mkdir()
            fields = ['S'] + ['0'] * 49
            fields[1], fields[19], fields[21] = '1', '101', '100'
            (process / 'stat').write_text('101 (azalea-bot) ' + ' '.join(fields))
            (process / 'cmdline').write_bytes(b'/app/azalea-bot\0--token\0must-not-be-exported\0')
            (process / 'smaps_rollup').write_text('Pss: 125 kB\n')
            output = Path(root) / 'report.json'
            real_path = Path

            def fixture_path(value):
                return proc if value == '/proc' else real_path(root) / 'sys' if value == '/sys/class/thermal' else real_path(value)

            with patch.object(sampler, 'Path', side_effect=fixture_path), \
                 patch.object(sampler.platform, 'system', return_value='Linux'), \
                 patch('sys.argv', ['measure-host.py', '--duration', '.5', '--interval', '.5', '--output', str(output)]), \
                 patch.object(sampler.signal, 'signal'), contextlib.redirect_stdout(io.StringIO()):
                sampler.main()
            raw = output.read_text()
            report = json.loads(raw)
            self.assertEqual(report['summary']['java']['processes']['max'], 1)
            self.assertEqual(report['summary']['java']['pss_mib']['max'], 125 / 1024)
            self.assertGreaterEqual(len(report['samples']), 2)
            self.assertNotIn('must-not-be-exported', raw)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
