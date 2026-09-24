import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name('gama-crm-audit-monitor.py')
spec = importlib.util.spec_from_file_location('gama_crm_monitor_security', MODULE_PATH)
monitor = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(monitor)

STAMP = '2026-09-04T05:00:00.000Z'
REF_A = 'a' * 32
REF_B = 'b' * 32


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


def valid_message(timestamp=STAMP):
    return {
        'sender': 'customer',
        'type': 'text',
        'status': 'received',
        'ai_generated': False,
        'at': timestamp,
        'signal': 'question',
    }


def snapshot_with_message(timestamp=STAMP):
    snapshot = valid_snapshot()
    snapshot['metrics'].update(conversations=1, open_conversations=1, messages=1)
    snapshot['customer_review']['recent_interactions'] = [
        {
            'conversation_ref': REF_A,
            'status': 'open',
            'assigned': False,
            'ai_disabled': False,
            'ai_handoff': False,
            'last_message_at': timestamp,
            'latest_sender': 'customer',
            'recent_messages': [valid_message(timestamp)],
        }
    ]
    return snapshot


class StrictJsonTests(unittest.TestCase):
    def test_schema_version_requires_an_integer(self):
        for value in (2.0, '2', True):
            with self.subTest(value=value):
                snapshot = valid_snapshot()
                snapshot['schema_version'] = value
                with self.assertRaisesRegex(ValueError, 'no compatible'):
                    monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_numeric_privacy_boolean_spoofing(self):
        for spoofed in (0, 0.0):
            with self.subTest(spoofed=spoofed):
                snapshot = valid_snapshot()
                snapshot['privacy']['raw_customer_identifiers_included'] = spoofed
                with self.assertRaisesRegex(ValueError, 'privacidad'):
                    monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_duplicate_top_level_and_nested_members(self):
        raw = json.dumps(valid_snapshot())
        duplicate_schema = raw.replace(
            '"schema_version": 2',
            '"schema_version": 1, "schema_version": 2',
            1,
        )
        with self.assertRaisesRegex(ValueError, 'JSON'):
            monitor.normalise_snapshot(duplicate_schema)

        duplicate_privacy = raw.replace(
            '"raw_customer_identifiers_included": false',
            '"raw_customer_identifiers_included": true, '
            '"raw_customer_identifiers_included": false',
            1,
        )
        with self.assertRaisesRegex(ValueError, 'JSON'):
            monitor.normalise_snapshot(duplicate_privacy)

    def test_rejects_nonstandard_infinities(self):
        raw = json.dumps(valid_snapshot())
        for constant in ('Infinity', '-Infinity'):
            with self.subTest(constant=constant):
                malformed = raw.replace('"contacts": 0', f'"contacts": {constant}', 1)
                with self.assertRaisesRegex(ValueError, 'JSON'):
                    monitor.normalise_snapshot(malformed)


class CanonicalTimestampTests(unittest.TestCase):
    def test_accepts_the_collector_wire_format(self):
        monitor.normalise_snapshot(json.dumps(snapshot_with_message()))

    def test_rejects_noncanonical_timestamp_variants(self):
        variants = (
            '2026-09-04 05:00:00',
            '2026-09-04T05:00:00+00:00',
            '2026-09-04T05:00:00.000+00:00',
            '2026-09-04T05:00:00Z',
            '2026-02-30T05:00:00.000Z',
        )
        for timestamp in variants:
            with self.subTest(timestamp=timestamp):
                with self.assertRaisesRegex(ValueError, 'fecha'):
                    monitor.normalise_snapshot(
                        json.dumps(snapshot_with_message(timestamp))
                    )


class BoundsAndSchemaTests(unittest.TestCase):
    def test_rejects_customer_list_and_message_caps(self):
        wait = {
            'incident_key': 'awaiting:' + REF_A,
            'severity': 'high',
            'age_bucket': '2h-24h',
            'assigned': False,
            'ai_disabled': False,
            'ai_handoff': False,
            'status': 'open',
            'customer_signal': 'question',
            'latest_content_type': 'text',
            'conversation_ref': REF_A,
            'recent_messages': [],
        }
        snapshot = valid_snapshot()
        snapshot['customer_review']['awaiting_response'] = [dict(wait) for _ in range(4)]
        with self.assertRaisesRegex(ValueError, 'lista'):
            monitor.normalise_snapshot(json.dumps(snapshot))

        snapshot = snapshot_with_message()
        snapshot['customer_review']['recent_interactions'][0]['recent_messages'].append(
            valid_message()
        )
        with self.assertRaisesRegex(ValueError, 'lista'):
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_accepts_every_technical_incident_schema(self):
        cases = {
            'failed_messages': {
                'incident_key': 'message-failed:' + REF_A,
                'severity': 'high',
                'conversation_ref': REF_A,
                'sender': 'agent',
                'content_type': 'text',
                'ai_generated': False,
                'age_bucket': '30m-2h',
                'at': STAMP,
                'reason_code': 'other',
            },
            'stale_sent_messages': {
                'incident_key': 'message-stale:' + REF_A,
                'severity': 'medium',
                'conversation_ref': REF_A,
                'sender': 'bot',
                'content_type': 'template',
                'ai_generated': True,
                'age_bucket': '2h-24h',
                'at': STAMP,
                'delivery_status': 'sent',
            },
            'automation_failures': {
                'incident_key': 'automation-failed:' + REF_A,
                'severity': 'high',
                'automation_ref': REF_B,
                'error_code': 'timeout',
                'step_type': 'send_message',
                'occurrences': 1,
                'latest_at': STAMP,
            },
            'overdue_automation_executions': {
                'incident_key': 'automation-overdue:' + REF_A,
                'severity': 'high',
                'automation_ref': REF_B,
                'age_bucket': '1d-7d',
                'run_at': STAMP,
            },
            'flow_incidents': {
                'incident_key': 'flow-failed:' + REF_A,
                'severity': 'high',
                'flow_ref': REF_B,
                'reason_code': 'send_error',
                'conversation_ref': None,
            },
            'webhook_incidents': {
                'incident_key': 'webhook:' + REF_A,
                'severity': 'high',
                'active': False,
                'consecutive_failures': 2,
                'last_delivery_at': STAMP,
            },
            'whatsapp_incidents': {
                'incident_key': 'whatsapp:' + REF_A,
                'severity': 'critical',
                'status': 'disconnected',
                'has_registration_error': True,
            },
        }
        for category, incident in cases.items():
            with self.subTest(category=category):
                snapshot = valid_snapshot()
                snapshot['technical'][category] = [incident]
                snapshot['metrics']['messages'] = 1
                monitor.normalise_snapshot(json.dumps(snapshot))

    def test_rejects_invalid_incident_reference_and_enum(self):
        snapshot = valid_snapshot()
        incident = {
            'incident_key': 'webhook:not-a-reference',
            'severity': 'critical',
            'active': False,
            'consecutive_failures': 1,
            'last_delivery_at': None,
        }
        snapshot['technical']['webhook_incidents'] = [incident]
        with self.assertRaisesRegex(ValueError, 'incident_key'):
            monitor.normalise_snapshot(json.dumps(snapshot))

        incident['incident_key'] = 'webhook:' + REF_A
        incident['severity'] = 'urgent'
        with self.assertRaisesRegex(ValueError, 'severity'):
            monitor.normalise_snapshot(json.dumps(snapshot))


def snapshot_with_wait(ref=REF_A):
    snapshot = valid_snapshot()
    snapshot['metrics'].update(conversations=1, open_conversations=1, messages=1)
    snapshot['customer_review']['awaiting_response'] = [{
        'incident_key': 'awaiting:' + ref, 'severity': 'high',
        'age_bucket': '2h-24h', 'assigned': False, 'ai_disabled': False,
        'ai_handoff': False, 'status': 'open', 'customer_signal': 'question',
        'latest_content_type': 'text', 'conversation_ref': ref,
        'recent_messages': [valid_message()],
    }]
    return snapshot


class ProducerContractTests(unittest.TestCase):
    def test_awaiting_signal_content_and_reference_invariants(self):
        for field, value in (
            ('customer_signal', 'closure'), ('customer_signal', 'do_not_contact'),
            ('customer_signal', 'empty'), ('customer_signal', 'media'),
            ('latest_content_type', 'image'), ('incident_key', 'awaiting:' + REF_B),
            ('recent_messages', []),
        ):
            with self.subTest(field=field, value=value):
                snapshot = snapshot_with_wait()
                snapshot['customer_review']['awaiting_response'][0][field] = value
                with self.assertRaises(ValueError):
                    monitor.normalise_snapshot(json.dumps(snapshot))
        for signal in ('commercial_request', 'frustration', 'media', 'other', 'question'):
            snapshot = snapshot_with_wait()
            row = snapshot['customer_review']['awaiting_response'][0]
            row['customer_signal'] = signal
            row['latest_content_type'] = 'audio' if signal == 'media' else 'text'
            # Context is the latest message, not necessarily the latest customer message.
            row['recent_messages'][0].update(sender='bot', status='sent')
            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_awaiting_severity_follows_age(self):
        for age, expected in (('<30m', 'medium'), ('30m-2h', 'medium'),
                              ('2h-24h', 'high'), ('1d-7d', 'high'), ('7d+', 'high')):
            for severity in ('low', 'medium', 'high', 'critical'):
                with self.subTest(age=age, severity=severity):
                    snapshot = snapshot_with_wait()
                    snapshot['customer_review']['awaiting_response'][0].update(
                        age_bucket=age, severity=severity)
                    if severity == expected:
                        monitor.normalise_snapshot(json.dumps(snapshot))
                    else:
                        with self.assertRaises(ValueError):
                            monitor.normalise_snapshot(json.dumps(snapshot))

    def test_recent_message_metadata_matches_producer(self):
        for field, value in (
            ('latest_sender', 'unknown'),
            ('latest_sender', 'agent'),
            ('last_message_at', '2026-09-04T04:00:00.000Z'),
            ('recent_messages', []),
        ):
            with self.subTest(field=field, value=value):
                snapshot = snapshot_with_message()
                snapshot['customer_review']['recent_interactions'][0][field] = value
                with self.assertRaises(ValueError):
                    monitor.normalise_snapshot(json.dumps(snapshot))
        for field, value in (('sender', 'unknown'), ('status', 'unknown'),
                             ('signal', 'media'), ('type', 'image')):
            with self.subTest(field=field, value=value):
                snapshot = snapshot_with_message()
                snapshot['customer_review']['recent_interactions'][0]['recent_messages'][0][field] = value
                with self.assertRaises(ValueError):
                    monitor.normalise_snapshot(json.dumps(snapshot))

    def test_accepts_only_producer_message_state_combinations(self):
        allowed = {
            ('customer', 'received'),
            ('customer', 'delivered'),
            ('customer', 'read'),
            *(('agent', status) for status in ('sending', 'sent', 'delivered', 'read', 'failed')),
            *(('bot', status) for status in ('sending', 'sent', 'delivered', 'read', 'failed')),
        }
        all_states = {
            (sender, status)
            for sender in ('customer', 'agent', 'bot')
            for status in ('sending', 'sent', 'delivered', 'read', 'failed', 'received')
        }
        for sender, status in sorted(allowed):
            with self.subTest(sender=sender, status=status, allowed=True):
                snapshot = snapshot_with_message()
                row = snapshot['customer_review']['recent_interactions'][0]
                row['latest_sender'] = row['recent_messages'][0]['sender'] = sender
                row['recent_messages'][0]['status'] = status
                monitor.normalise_snapshot(json.dumps(snapshot))
        for sender, status in sorted(all_states - allowed):
            with self.subTest(sender=sender, status=status, allowed=False):
                snapshot = snapshot_with_message()
                row = snapshot['customer_review']['recent_interactions'][0]
                row['latest_sender'] = row['recent_messages'][0]['sender'] = sender
                row['recent_messages'][0]['status'] = status
                with self.assertRaises(ValueError):
                    monitor.normalise_snapshot(json.dumps(snapshot))
        for content_type in monitor.CONTENT_TYPES - {'text'}:
            snapshot = snapshot_with_message()
            snapshot['customer_review']['recent_interactions'][0]['recent_messages'][0].update(
                type=content_type, signal='media')
            monitor.normalise_snapshot(json.dumps(snapshot))


class SubprocessBoundaryTests(unittest.TestCase):
    def test_invokes_collector_without_shell(self):
        calls = []

        def run_impl(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(valid_snapshot()).encode('utf-8'),
                stderr=b'',
            )

        output = monitor.collect_snapshot(run_impl=run_impl)

        self.assertEqual(json.loads(output), valid_snapshot())
        self.assertEqual(
            calls[0][0],
            [
                '/usr/bin/sandbox-exec',
                '-f',
                str(monitor.SANDBOX_PROFILE),
                '/usr/local/bin/node',
                str(monitor.AUDIT_SCRIPT),
            ],
        )
        self.assertIs(calls[0][1]['shell'], False)
        self.assertEqual(calls[0][1]['cwd'], monitor.PROJECT_ROOT)
        self.assertEqual(calls[0][1]['env'], monitor.SAFE_CHILD_ENV)
        self.assertNotIn('NODE_OPTIONS', calls[0][1]['env'])
        self.assertNotIn('HTTPS_PROXY', calls[0][1]['env'])
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', calls[0][1]['env'])

    def test_never_forwards_child_stderr(self):
        secret = 'synthetic child stderr that must stay local'

        def run_impl(_command, **_kwargs):
            return SimpleNamespace(returncode=1, stdout=b'', stderr=secret.encode())

        with self.assertRaises(ValueError) as raised:
            monitor.collect_snapshot(run_impl=run_impl)
        self.assertNotIn(secret, str(raised.exception))

    def test_bounded_runner_kills_stdout_overflow_before_capture(self):
        command = [
            sys.executable,
            '-c',
            'import sys; sys.stdout.buffer.write(b"x" * 257)',
        ]
        with self.assertRaisesRegex(ValueError, 'salida'):
            monitor.run_bounded_command(
                command,
                cwd=monitor.PROJECT_ROOT,
                env=monitor.SAFE_CHILD_ENV,
                timeout_seconds=2,
                stdout_limit=256,
                stderr_limit=256,
            )

    def test_bounded_runner_kills_stderr_overflow_before_capture(self):
        command = [
            sys.executable,
            '-c',
            'import sys; sys.stderr.buffer.write(b"x" * 257)',
        ]
        with self.assertRaisesRegex(ValueError, 'salida'):
            monitor.run_bounded_command(
                command,
                cwd=monitor.PROJECT_ROOT,
                env=monitor.SAFE_CHILD_ENV,
                timeout_seconds=2,
                stdout_limit=256,
                stderr_limit=256,
            )

    def test_bounded_runner_kills_a_timed_out_process(self):
        command = [sys.executable, '-c', 'import time; time.sleep(1)']
        with self.assertRaisesRegex(ValueError, 'tiempo'):
            monitor.run_bounded_command(
                command,
                cwd=monitor.PROJECT_ROOT,
                env=monitor.SAFE_CHILD_ENV,
                timeout_seconds=0.05,
                stdout_limit=256,
                stderr_limit=256,
            )


if __name__ == '__main__':
    unittest.main()

