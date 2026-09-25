"""Offline process-boundary regressions; never run the CRM collector."""
import importlib.util
import math
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

MODULE_PATH = Path(__file__).resolve().with_name('gama-crm-audit-monitor.py')
spec = importlib.util.spec_from_file_location('gama_monitor_process_tests', MODULE_PATH)
assert spec is not None and spec.loader is not None
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class ProcessCleanupTests(unittest.TestCase):
    def test_terminates_descendants_even_after_the_group_leader_exits(self):
        process = Mock(pid=987654)
        process.poll.return_value = 0
        with patch.object(monitor.os, 'killpg') as killpg:
            monitor._terminate_process_group(process)
        killpg.assert_called_once_with(process.pid, monitor.signal.SIGKILL)
        process.wait.assert_called_once()

    def test_rejects_nonfinite_deadlines_before_spawning(self):
        for duration in (math.inf, math.nan):
            with self.subTest(duration=duration), patch.object(monitor.subprocess, 'Popen') as popen:
                with self.assertRaises(ValueError):
                    monitor.run_bounded_command(
                        ['synthetic-never-executed'], cwd='/', env={},
                        timeout_seconds=duration, stdout_limit=256, stderr_limit=256,
                    )
                popen.assert_not_called()

    def test_test_module_is_adjacent_to_candidate(self):
        self.assertEqual(Path(monitor.__file__).resolve(), MODULE_PATH)


if __name__ == '__main__':
    unittest.main()
