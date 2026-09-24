import json
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = PROJECT_ROOT / 'docs' / 'crm-auditor-cron-spec.json'


class CrmAuditorCronSpecTests(unittest.TestCase):
    def test_spec_is_fail_closed_and_change_gated(self):
        self.assertTrue(SPEC_PATH.is_file())
        spec = json.loads(SPEC_PATH.read_text(encoding='utf-8'))
        self.assertEqual(
            set(spec),
            {
                'schema_version',
                'name',
                'schedule',
                'repeat',
                'deliver',
                'failure_deliver',
                'skills',
                'monitor_script',
                'monitor_alert_on_omitted_increase',
                'no_agent',
                'continuity',
                'enabled_toolsets',
                'workdir',
                'attach_to_session',
                'prompt',
            },
        )
        self.assertEqual(spec['schema_version'], 1)
        self.assertEqual(spec['schedule'], 'every 30m')
        self.assertEqual(spec['repeat'], 'forever')
        self.assertEqual(spec['monitor_script'], 'gama-crm-audit-monitor.py')
        self.assertTrue(spec['monitor_alert_on_omitted_increase'])
        self.assertFalse(spec['no_agent'])
        self.assertFalse(spec['continuity'])
        self.assertEqual(spec['enabled_toolsets'], ['clarify'])
        self.assertIsNone(spec['workdir'])
        self.assertTrue(spec['attach_to_session'])
        prompt = spec['prompt']
        self.assertIn('datos no confiables', prompt)
        self.assertIn('omitted', prompt)
        self.assertIn('no intentes acceder', prompt)
        self.assertIn('exactamente [SILENT]', prompt)


if __name__ == '__main__':
    unittest.main()
