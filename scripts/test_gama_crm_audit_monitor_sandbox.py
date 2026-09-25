import importlib.util
import os
import stat
import subprocess
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    'gama_crm_monitor_sandbox', HERE / 'gama-crm-audit-monitor.py'
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class SandboxProfileTests(unittest.TestCase):
    def test_profile_is_owned_regular_and_not_group_writable(self):
        profile_stat = monitor.SANDBOX_PROFILE.lstat()
        self.assertTrue(stat.S_ISREG(profile_stat.st_mode))
        self.assertEqual(profile_stat.st_uid, os.getuid())
        self.assertFalse(profile_stat.st_mode & 0o022)

    def test_profile_denies_service_environment_and_all_writes(self):
        probe_path = '/tmp/gama-crm-audit-sandbox-probe'
        try:
            result = subprocess.run(
                [
                    str(monitor.SANDBOX_EXECUTABLE),
                    '-f',
                    str(monitor.SANDBOX_PROFILE),
                    str(monitor.NODE_EXECUTABLE),
                    '-e',
                    """
const fs = require('node:fs');
let envDenied = false;
let writeDenied = false;
try { const fd = fs.openSync('.env', 'r'); fs.closeSync(fd); }
catch { envDenied = true; }
try { fs.writeFileSync('/tmp/gama-crm-audit-sandbox-probe', 'x'); }
catch { writeDenied = true; }
const sourceReadable = fs.readFileSync(
  'src/lib/audit/reference-key.mjs',
  'utf8'
).length > 0;
process.exit(envDenied && writeDenied && sourceReadable ? 0 : 9);
""",
                ],
                cwd=monitor.PROJECT_ROOT,
                env=monitor.SAFE_CHILD_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0)
        finally:
            Path(probe_path).unlink(missing_ok=True)

    def test_profile_denies_reading_files_outside_the_collector_allowlist(self):
        secret_path = Path.home() / 'gama-crm-audit-sandbox-synthetic-secret'
        temp_secret_path = Path('/private/tmp/gama-crm-audit-sandbox-synthetic-secret')
        secret_path.write_text('synthetic-secret', encoding='utf-8')
        temp_secret_path.write_text('synthetic-secret', encoding='utf-8')
        secret_path.chmod(0o600)
        temp_secret_path.chmod(0o600)
        try:
            result = subprocess.run(
                [
                    str(monitor.SANDBOX_EXECUTABLE),
                    '-f',
                    str(monitor.SANDBOX_PROFILE),
                    str(monitor.NODE_EXECUTABLE),
                    '-e',
                    """
const fs = require('node:fs');
let homeDenied = false;
let repoDenied = false;
let tempDenied = false;
try { fs.readFileSync(process.argv[1], 'utf8'); }
catch { homeDenied = true; }
try { fs.readFileSync('.env', 'utf8'); }
catch { repoDenied = true; }
try { fs.readFileSync(process.argv[2], 'utf8'); }
catch { tempDenied = true; }
const sourceReadable = fs.readFileSync(
  'src/lib/audit/reference-key.mjs',
  'utf8'
).length > 0;
process.exit(homeDenied && repoDenied && tempDenied && sourceReadable ? 0 : 9);
""",
                    str(secret_path),
                    str(temp_secret_path),
                ],
                cwd=monitor.PROJECT_ROOT,
                env=monitor.SAFE_CHILD_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0)
        finally:
            secret_path.unlink(missing_ok=True)
            temp_secret_path.unlink(missing_ok=True)

    def test_profile_explicitly_denies_process_fork(self):
        profile = monitor.SANDBOX_PROFILE.read_text(encoding='utf-8')
        self.assertIn('(deny process-fork)', profile)

    def test_profile_denies_child_process_creation_so_descendants_cannot_detach(self):
        result = subprocess.run(
            [
                str(monitor.SANDBOX_EXECUTABLE),
                '-f',
                str(monitor.SANDBOX_PROFILE),
                str(monitor.NODE_EXECUTABLE),
                '-e',
                """
const { spawnSync } = require('node:child_process');
const child = spawnSync('/usr/bin/true', [], { stdio: 'ignore' });
process.exit(child.error && child.status === null ? 0 : 9);
""",
            ],
            cwd=monitor.PROJECT_ROOT,
            env=monitor.SAFE_CHILD_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )

        self.assertEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
