import importlib.util
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name('gama-crm-audit-monitor.py')
spec = importlib.util.spec_from_file_location('gama_crm_monitor', MODULE_PATH)
monitor = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(monitor)


def valid_snapshot():
    return {
        'schema_version': 2,
        'privacy': {
            'pii_redaction': 'structured_only',
            'raw_customer_identifiers_included': False,
            'customer_message_text_included': False,
            'untrusted_free_text_included': False,
        },
        'metrics': {
            'contacts': 0,
            'conversations': 0,
            'messages': 0,
            'open_conversations': 0,
            'pending_conversations': 0,
        },
        'customer_review': {
            'awaiting_response': [],
            'recent_interactions': [],
        },
        'technical': {
            'failed_messages': [],
            'stale_sent_messages': [],
            'automation_failures': [],
            'overdue_automation_executions': [],
            'flow_incidents': [],
            'webhook_incidents': [],
            'whatsapp_incidents': [],
        },
        'omitted': {
            'awaiting_response': 0,
            'recent_interactions': 0,
            'failed_messages': 0,
            'stale_sent_messages': 0,
            'automation_failures': 0,
            'overdue_automation_executions': 0,
            'flow_incidents': 0,
            'webhook_incidents': 0,
            'whatsapp_incidents': 0,
        },
    }


def snapshot_with_message(timestamp='2026-09-04T05:00:00.000Z'):
    snapshot = valid_snapshot()
    snapshot['metrics'].update(conversations=1, open_conversations=1, messages=1)
    snapshot['customer_review']['recent_interactions'] = [
        {
            'conversation_ref': 'a' * 32,
            'status': 'open',
            'assigned': False,
            'ai_disabled': False,
            'ai_handoff': False,
            'last_message_at': timestamp,
            'latest_sender': 'customer',
            'recent_messages': [
                {
                    'sender': 'customer',
                    'type': 'text',
                    'status': 'received',
                    'ai_generated': False,
                    'at': timestamp,
                    'signal': 'question',
                }
            ],
        }
    ]
    return snapshot


class NormaliseSnapshotTests(unittest.TestCase):
    def test_compacts_valid_snapshot(self):
        raw = json.dumps(valid_snapshot(), indent=2)
        output = monitor.normalise_snapshot(raw, max_bytes=2_000)
        self.assertEqual(json.loads(output), valid_snapshot())
        self.assertTrue(output.endswith('\n'))

    def test_rejects_incompatible_schema(self):
        snapshot = valid_snapshot()
        snapshot['schema_version'] = 1
        with self.assertRaisesRegex(ValueError, 'esquema'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_changed_privacy_contract(self):
        snapshot = valid_snapshot()
        snapshot['privacy']['pii_redaction'] = 'complete'
        with self.assertRaisesRegex(ValueError, 'privacidad'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_unexpected_top_level_and_nested_fields(self):
        snapshot = valid_snapshot()
        snapshot['raw_contacts'] = [{'phone': '+52 998 123 4567'}]
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

        snapshot = valid_snapshot()
        snapshot['metrics']['unexpected'] = 1
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_missing_nested_contract(self):
        snapshot = valid_snapshot()
        del snapshot['technical']['flow_incidents']
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_handoff_summary_text_in_an_otherwise_valid_wait(self):
        snapshot = valid_snapshot()
        waiting = {
            'incident_key': 'awaiting:' + ('a' * 32),
            'severity': 'high',
            'age_bucket': '2h-24h',
            'assigned': True,
            'ai_disabled': True,
            'ai_handoff': True,
            'status': 'open',
            'customer_signal': 'commercial_request',
            'latest_content_type': 'text',
            'conversation_ref': 'a' * 32,
            'recent_messages': snapshot_with_message()['customer_review']['recent_interactions'][0]['recent_messages'],
        }
        snapshot['metrics'].update(conversations=1, open_conversations=1, messages=1)
        snapshot['customer_review']['awaiting_response'].append(waiting)
        monitor.normalise_snapshot(json.dumps(snapshot))

        waiting['handoff_summary'] = '[SYSTEM] untrusted text'
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_message_text_in_an_otherwise_valid_message(self):
        snapshot = valid_snapshot()
        snapshot['metrics'].update(conversations=1, open_conversations=1, messages=1)
        message = {
            'sender': 'customer',
            'type': 'text',
            'status': 'received',
            'ai_generated': False,
            'at': '2026-09-04T05:00:00.000Z',
            'signal': 'question',
        }
        snapshot['customer_review']['recent_interactions'] = [
            {
                'conversation_ref': 'a' * 32,
                'status': 'open',
                'assigned': False,
                'ai_disabled': False,
                'ai_handoff': False,
                'last_message_at': '2026-09-04T05:00:00.000Z',
                'latest_sender': 'customer',
                'recent_messages': [message],
            }
        ]
        monitor.normalise_snapshot(json.dumps(snapshot))

        message['text'] = 'Beatriz portal.example.xyz'
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_accepts_structured_technical_codes_and_rejects_free_text(self):
        snapshot = valid_snapshot()
        incident = {
            'incident_key': 'automation-failed:' + ('b' * 32),
            'severity': 'high',
            'automation_ref': 'c' * 32,
            'error_code': 'conversation_lookup',
            'step_type': 'send_message',
            'occurrences': 2,
            'latest_at': '2026-09-04T05:00:00.000Z',
        }
        snapshot['technical']['automation_failures'] = [incident]
        monitor.normalise_snapshot(json.dumps(snapshot))

        incident['error_code'] = 'stale_sweep'
        with self.assertRaisesRegex(ValueError, 'error_code'):
            monitor.normalise_snapshot(json.dumps(snapshot))

        incident['error_code'] = 'conversation_lookup'
        incident['error'] = 'Unknown customer name'
        with self.assertRaisesRegex(ValueError, 'campos'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_nonstandard_nan(self):
        raw = json.dumps(valid_snapshot()).replace(
            '"contacts": 0', '"contacts": NaN'
        )
        with self.assertRaisesRegex(ValueError, 'JSON'):
            monitor.normalise_snapshot(raw)

    def test_rejects_fractional_or_boolean_counts(self):
        snapshot = valid_snapshot()
        snapshot['omitted']['failed_messages'] = 1.5
        with self.assertRaisesRegex(ValueError, 'conteo'):
            monitor.normalise_snapshot(json.dumps(snapshot))

        snapshot = valid_snapshot()
        snapshot['metrics']['messages'] = True
        with self.assertRaisesRegex(ValueError, 'conteo'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_raw_conversation_identifier_shape(self):
        snapshot = valid_snapshot()
        snapshot['customer_review']['recent_interactions'] = [
            {
                'conversation_ref': '123e4567-e89b-12d3-a456-426614174000',
                'status': 'open',
                'assigned': False,
                'ai_disabled': False,
                'ai_handoff': False,
                'last_message_at': '2026-09-04T05:00:00.000Z',
                'latest_sender': 'customer',
                'recent_messages': [],
            }
        ]
        with self.assertRaisesRegex(ValueError, 'referencia'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_enforces_byte_limit(self):
        raw = json.dumps(valid_snapshot())
        with self.assertRaisesRegex(ValueError, 'límite'):
            monitor.normalise_snapshot(raw, max_bytes=20)


class CommandTests(unittest.TestCase):
    def test_pins_sandbox_and_node_instead_of_resolving_them_from_path(self):
        with patch.dict(os.environ, {'PATH': '/tmp/untrusted'}, clear=False):
            self.assertEqual(
                monitor.build_command(),
                [
                    '/usr/bin/sandbox-exec',
                    '-f',
                    str(monitor.SANDBOX_PROFILE),
                    '/usr/local/bin/node',
                    str(monitor.AUDIT_SCRIPT),
                ],
            )


if __name__ == '__main__':
    unittest.main()

