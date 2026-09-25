"""Offline mutations that keep the Python gate aligned with snapshot v2."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

MODULE_PATH = Path(__file__).resolve().with_name("gama-crm-audit-monitor.py")
spec = importlib.util.spec_from_file_location("gama_crm_monitor_contract", MODULE_PATH)
assert spec is not None and spec.loader is not None
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
PROJECT_ROOT = MODULE_PATH.parent.parent

STAMP = "2026-09-04T05:00:00.000Z"
REF_A = "a" * 32
REF_B = "b" * 32
REF_C = "c" * 32


def message(sender="customer", status="received", at=STAMP):
    return {
        "sender": sender,
        "type": "text",
        "status": status,
        "ai_generated": False,
        "at": at,
        "signal": "question",
    }


def base_snapshot():
    return {
        "schema_version": 2,
        "privacy": {
            "pii_redaction": "structured_only",
            "raw_customer_identifiers_included": False,
            "customer_message_text_included": False,
            "untrusted_free_text_included": False,
        },
        "metrics": {
            "contacts": 0,
            "conversations": 0,
            "messages": 0,
            "open_conversations": 0,
            "pending_conversations": 0,
        },
        "customer_review": {"awaiting_response": [], "recent_interactions": []},
        "technical": {
            "failed_messages": [],
            "stale_sent_messages": [],
            "automation_failures": [],
            "overdue_automation_executions": [],
            "flow_incidents": [],
            "webhook_incidents": [],
            "whatsapp_incidents": [],
        },
        "omitted": {
            "awaiting_response": 0,
            "recent_interactions": 0,
            "failed_messages": 0,
            "stale_sent_messages": 0,
            "automation_failures": 0,
            "overdue_automation_executions": 0,
            "flow_incidents": 0,
            "webhook_incidents": 0,
            "whatsapp_incidents": 0,
        },
    }


def awaiting(ref=REF_A, age="2h-24h", handoff=False, assigned=False):
    return {
        "incident_key": "awaiting:" + ref,
        "severity": "medium" if age in {"<30m", "30m-2h"} else "high",
        "age_bucket": age,
        "assigned": assigned,
        "ai_disabled": False,
        "ai_handoff": handoff,
        "status": "open",
        "customer_signal": "question",
        "latest_content_type": "text",
        "conversation_ref": ref,
        "recent_messages": [message()],
    }


def failed(ref=REF_A):
    return {
        "incident_key": "message-failed:" + ref,
        "severity": "high",
        "conversation_ref": REF_C,
        "sender": "agent",
        "content_type": "text",
        "ai_generated": False,
        "age_bucket": "2h-24h",
        "at": STAMP,
        "reason_code": "other",
    }


def normalise(snapshot):
    return monitor.normalise_snapshot(json.dumps(snapshot))


class ExactProducerContractTests(unittest.TestCase):
    def test_accepts_snapshot_from_adjacent_javascript_producer_offline(self):
        script = r"""
import { buildAuditSnapshot } from './src/lib/audit/crm-auditor.mjs';
const data = {
  contacts: [{ id: 'contact-1' }],
  conversations: [{
    id: 'conversation-1', contact_id: 'contact-1', status: 'open',
    assigned_agent_id: null, ai_autoreply_disabled: false,
    ai_handoff_summary: null,
  }],
  messages: [{
    id: 'message-1', conversation_id: 'conversation-1',
    sender_type: 'customer', content_type: 'text',
    content_text: '¿Me ayudan?', status: 'received',
    created_at: '2026-09-04T04:00:00.000Z', ai_generated: false,
  }],
  automations: [], automationLogs: [], pendingExecutions: [],
  flows: [], flowRuns: [], webhookEndpoints: [],
  whatsappConfigs: [{
    id: 'whatsapp-1', status: 'connected', last_registration_error: null,
  }],
};
process.stdout.write(JSON.stringify(buildAuditSnapshot(data, {
  nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
  responseSlaMinutes: 30,
  referenceKey: Buffer.alloc(32, 7).toString('base64url'),
})));
"""
        result = subprocess.run(
            ["/usr/local/bin/node", "--input-type=module", "-e", script],
            cwd=PROJECT_ROOT,
            env={"LANG": "C", "LC_ALL": "C", "TZ": "UTC"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=10,
        )
        canonical = monitor.normalise_snapshot(result.stdout.decode("utf-8"))
        self.assertEqual(json.loads(canonical)["schema_version"], 2)

    def test_rejects_counts_above_source_bounds(self):
        for section, key in (("metrics", "contacts"), ("omitted", "failed_messages")):
            with self.subTest(section=section, key=key):
                snapshot = base_snapshot()
                snapshot[section][key] = 20_001
                with self.assertRaisesRegex(ValueError, "conteo|límite"):
                    normalise(snapshot)

        snapshot = base_snapshot()
        snapshot["technical"]["automation_failures"] = [{
            "incident_key": "automation-failed:" + REF_A,
            "severity": "high",
            "automation_ref": REF_B,
            "error_code": "other",
            "step_type": None,
            "occurrences": 20_001,
            "latest_at": STAMP,
        }]
        with self.assertRaisesRegex(ValueError, "conteo|límite"):
            normalise(snapshot)

    def test_automation_group_omission_uses_its_derived_finite_bound(self):
        snapshot = base_snapshot()
        snapshot["technical"]["automation_failures"] = [{
            "incident_key": "automation-failed:" + REF_A,
            "severity": "high",
            "automation_ref": REF_B,
            "error_code": "timeout",
            "step_type": "send_message",
            "occurrences": 1,
            "latest_at": STAMP,
        }]
        snapshot["omitted"]["automation_failures"] = 20_001
        normalise(snapshot)

        snapshot["omitted"]["automation_failures"] = 3_300_001
        with self.assertRaisesRegex(ValueError, "conteo|límite"):
            normalise(snapshot)

    def test_rejects_wrong_fixed_severities_and_flow_reason(self):
        cases = []
        snapshot = base_snapshot()
        row = failed()
        row["severity"] = "critical"
        snapshot["technical"]["failed_messages"] = [row]
        cases.append(snapshot)

        snapshot = base_snapshot()
        snapshot["technical"]["flow_incidents"] = [{
            "incident_key": "flow-stalled:" + REF_A,
            "severity": "high",
            "flow_ref": REF_B,
            "reason_code": "other",
            "age_bucket": "2h-24h",
            "conversation_ref": None,
        }]
        cases.append(snapshot)

        snapshot = base_snapshot()
        snapshot["technical"]["webhook_incidents"] = [{
            "incident_key": "webhook:" + REF_A,
            "severity": "high",
            "active": True,
            "consecutive_failures": 1,
            "last_delivery_at": None,
        }]
        cases.append(snapshot)

        snapshot = base_snapshot()
        snapshot["technical"]["whatsapp_incidents"] = [{
            "incident_key": "whatsapp:" + REF_A,
            "severity": "critical",
            "status": "connected",
            "has_registration_error": True,
        }]
        cases.append(snapshot)

        for index, case in enumerate(cases):
            with self.subTest(case=index), self.assertRaises(ValueError):
                normalise(case)

    def test_rejects_duplicate_or_overlapping_output_identities(self):
        snapshot = base_snapshot()
        snapshot["metrics"].update(conversations=2, open_conversations=2, messages=2)
        snapshot["customer_review"]["awaiting_response"] = [
            awaiting(REF_A),
            awaiting(REF_A),
        ]
        with self.assertRaisesRegex(ValueError, "duplicad|únic|inconsistente"):
            normalise(snapshot)

        snapshot = base_snapshot()
        snapshot["metrics"].update(conversations=1, open_conversations=1, messages=1)
        snapshot["customer_review"]["awaiting_response"] = [awaiting(REF_A)]
        snapshot["customer_review"]["recent_interactions"] = [{
            "conversation_ref": REF_A,
            "status": "open",
            "assigned": False,
            "ai_disabled": False,
            "ai_handoff": False,
            "last_message_at": STAMP,
            "latest_sender": "customer",
            "recent_messages": [message()],
        }]
        with self.assertRaisesRegex(ValueError, "duplicad|únic|inconsistente"):
            normalise(snapshot)

    def test_rejects_impossible_omission_and_candidate_totals(self):
        snapshot = base_snapshot()
        snapshot["omitted"]["failed_messages"] = 1
        with self.assertRaisesRegex(ValueError, "omit|inconsistente"):
            normalise(snapshot)

        snapshot = base_snapshot()
        snapshot["technical"]["failed_messages"] = [failed()]
        snapshot["metrics"]["messages"] = 0
        with self.assertRaisesRegex(ValueError, "conteo|inconsistente"):
            normalise(snapshot)

    def test_rejects_noncanonical_awaiting_priority_order(self):
        snapshot = base_snapshot()
        snapshot["metrics"].update(conversations=2, open_conversations=2, messages=2)
        snapshot["customer_review"]["awaiting_response"] = [
            awaiting(REF_A, age="7d+", handoff=False),
            awaiting(REF_B, age="<30m", handoff=True),
        ]
        with self.assertRaisesRegex(ValueError, "orden"):
            normalise(snapshot)

    def test_accepts_nonactionable_signal_only_for_a_pending_handoff(self):
        for signal in ("closure", "do_not_contact", "empty"):
            with self.subTest(signal=signal):
                snapshot = base_snapshot()
                snapshot["metrics"].update(
                    conversations=1, open_conversations=1, messages=1
                )
                row = awaiting(REF_A, handoff=True)
                row["customer_signal"] = signal
                row["recent_messages"][0]["signal"] = signal
                snapshot["customer_review"]["awaiting_response"] = [row]
                normalise(snapshot)

                row["ai_handoff"] = False
                with self.assertRaises(ValueError):
                    normalise(snapshot)

    def test_rejects_whatsapp_incidents_the_producer_cannot_emit(self):
        cases = [
            {
                "incident_key": "whatsapp:" + REF_A,
                "severity": "medium",
                "status": "connected",
                "has_registration_error": False,
            },
            {
                "incident_key": "whatsapp:" + REF_A,
                "severity": "critical",
                "status": "unknown",
                "has_registration_error": True,
            },
        ]
        for row in cases:
            with self.subTest(row=row):
                snapshot = base_snapshot()
                snapshot["technical"]["whatsapp_incidents"] = [row]
                with self.assertRaises(ValueError):
                    normalise(snapshot)


if __name__ == "__main__":
    unittest.main()
