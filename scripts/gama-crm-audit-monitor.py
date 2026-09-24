#!/usr/bin/env python3
"""Run the Gama CRM read-only collector for Hermes cron."""

from __future__ import annotations

import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path("/Users/alexandromagana/Developer/Gama Agency/Gama_CRM")
AUDIT_SCRIPT = PROJECT_ROOT / "scripts" / "audit-crm.mjs"
NODE_EXECUTABLE = Path("/usr/local/bin/node")
SANDBOX_EXECUTABLE = Path("/usr/bin/sandbox-exec")
SANDBOX_PROFILE = PROJECT_ROOT / "scripts" / "gama-crm-auditor.sb"
MAX_MONITOR_BYTES = 7_600
MAX_STDERR_BYTES = 4_096
COLLECTOR_TIMEOUT_SECONDS = 120
MAX_SOURCE_ROWS = 20_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
# 20k logs × 15 normalized step classes × 11 normalized error codes.
MAX_AUTOMATION_FAILURE_GROUPS = 3_300_000
SAFE_CHILD_ENV = {"LANG": "C", "LC_ALL": "C", "TZ": "UTC"}

TOP_LEVEL_FIELDS = {
    "schema_version",
    "privacy",
    "metrics",
    "customer_review",
    "technical",
    "omitted",
}
METRIC_FIELDS = {
    "contacts",
    "conversations",
    "messages",
    "open_conversations",
    "pending_conversations",
}
TECHNICAL_FIELDS = {
    "failed_messages",
    "stale_sent_messages",
    "automation_failures",
    "overdue_automation_executions",
    "flow_incidents",
    "webhook_incidents",
    "whatsapp_incidents",
}
OMITTED_FIELDS = {
    "awaiting_response",
    "recent_interactions",
    *TECHNICAL_FIELDS,
}
OMISSION_LIMITS = {
    **{key: MAX_SOURCE_ROWS for key in OMITTED_FIELDS},
    "automation_failures": MAX_AUTOMATION_FAILURE_GROUPS,
}
PRIVACY_CONTRACT = {
    "pii_redaction": "structured_only",
    "raw_customer_identifiers_included": False,
    "customer_message_text_included": False,
    "untrusted_free_text_included": False,
}
AGE_BUCKETS = {"<30m", "30m-2h", "2h-24h", "1d-7d", "7d+"}
SENDERS = {"customer", "agent", "bot"}
CONTENT_TYPES = {
    "text",
    "image",
    "document",
    "audio",
    "video",
    "location",
    "template",
    "interactive",
    "sticker",
    "unknown",
}
MESSAGE_STATUSES = {
    "sending",
    "sent",
    "delivered",
    "read",
    "failed",
    "received",
}
MESSAGE_SIGNALS = {
    "closure",
    "commercial_request",
    "do_not_contact",
    "empty",
    "frustration",
    "media",
    "other",
    "question",
}
CUSTOMER_SIGNAL_PRIORITY = {
    "do_not_contact": 6,
    "frustration": 5,
    "commercial_request": 4,
    "question": 3,
    "media": 2,
    "other": 1,
    "closure": 0,
    "empty": 0,
}
ERROR_CODES = {
    "authentication",
    "conversation_lookup",
    "meta_policy",
    "meta_template_missing",
    "meta_template_parameters",
    "network",
    "other",
    "rate_limit",
    "send_error",
    "timeout",
    "unspecified",
}
AUTOMATION_STEP_TYPES = {
    "send_message",
    "send_buttons",
    "send_list",
    "send_template",
    "add_tag",
    "remove_tag",
    "assign_conversation",
    "update_contact_field",
    "create_deal",
    "move_deal",
    "wait",
    "condition",
    "send_webhook",
    "close_conversation",
    "unknown",
}
WHATSAPP_STATUSES = {"connected", "disconnected", "pending", "unknown"}
REFERENCE_PATTERN = re.compile(r"^[0-9a-f]{32}$")
CANONICAL_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)


def require_exact_object(value, fields, path):
    if type(value) is not dict or set(value) != set(fields):
        raise ValueError(f"El snapshot contiene campos inválidos en {path}.")
    return value


def require_list(value, path, max_items):
    if type(value) is not list or len(value) > max_items:
        raise ValueError(f"El snapshot contiene una lista inválida en {path}.")
    return value


def require_bool(value, path):
    if type(value) is not bool:
        raise ValueError(f"El snapshot contiene un booleano inválido en {path}.")


def require_count(value, path, positive=False, maximum=MAX_SOURCE_ROWS):
    if (
        type(value) is not int
        or value < (1 if positive else 0)
        or value > maximum
    ):
        raise ValueError(f"El snapshot contiene un conteo inválido en {path}.")


def require_text(value, path, max_length, choices=None, nullable=False):
    if value is None and nullable:
        return
    if type(value) is not str or len(value.encode("utf-8")) > max_length:
        raise ValueError(f"El snapshot contiene texto inválido en {path}.")
    if choices is not None and value not in choices:
        raise ValueError(f"El snapshot contiene un valor inválido en {path}.")


def require_timestamp(value, path, nullable=False):
    if value is None and nullable:
        return
    require_text(value, path, 40)
    if not CANONICAL_TIMESTAMP.fullmatch(value):
        raise ValueError(f"El snapshot contiene una fecha no canónica en {path}.")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise ValueError(f"El snapshot contiene una fecha inválida en {path}.") from error


def reject_duplicate_members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("miembro JSON duplicado")
        result[key] = value
    return result


def require_reference(value, path, nullable=False):
    if value is None and nullable:
        return
    if type(value) is not str or REFERENCE_PATTERN.fullmatch(value) is None:
        raise ValueError(f"El snapshot contiene una referencia inválida en {path}.")


def require_incident_key(value, path, prefix):
    require_text(value, path, 64)
    if re.fullmatch(rf"{re.escape(prefix)}:[0-9a-f]{{32}}", value) is None:
        raise ValueError(f"El snapshot contiene una referencia inválida en {path}.")


def validate_recent_message(value, path):
    row = require_exact_object(
        value,
        {"sender", "type", "status", "ai_generated", "at", "signal"},
        path,
    )
    require_text(row["sender"], f"{path}.sender", 16, SENDERS)
    require_text(row["type"], f"{path}.type", 24, CONTENT_TYPES)
    require_text(row["status"], f"{path}.status", 16, MESSAGE_STATUSES)
    if row["sender"] == "customer":
        valid_state = row["status"] in {"received", "delivered", "read"}
    else:
        valid_state = row["status"] != "received"
    if not valid_state:
        raise ValueError(f"El snapshot contiene un estado de mensaje inválido en {path}.")
    require_bool(row["ai_generated"], f"{path}.ai_generated")
    require_timestamp(row["at"], f"{path}.at")
    require_text(row["signal"], f"{path}.signal", 24, MESSAGE_SIGNALS)
    require_content_signal(row["type"], row["signal"], path)


def require_content_signal(content_type, signal, path):
    if (content_type != "text") != (signal == "media"):
        raise ValueError(f"El snapshot contiene una señal inconsistente en {path}.")


def validate_recent_messages(value, path):
    rows = require_list(value, path, 1)
    if not rows:
        raise ValueError(f"El snapshot requiere un mensaje en la lista {path}.")
    for index, row in enumerate(rows):
        validate_recent_message(row, f"{path}[{index}]")


def validate_customer_review(value):
    review = require_exact_object(
        value, {"awaiting_response", "recent_interactions"}, "customer_review"
    )
    for index, value in enumerate(
        require_list(review["awaiting_response"], "customer_review.awaiting_response", 3)
    ):
        path = f"customer_review.awaiting_response[{index}]"
        row = require_exact_object(
            value,
            {
                "incident_key",
                "severity",
                "age_bucket",
                "assigned",
                "ai_disabled",
                "ai_handoff",
                "status",
                "customer_signal",
                "latest_content_type",
                "conversation_ref",
                "recent_messages",
            },
            path,
        )
        require_incident_key(row["incident_key"], f"{path}.incident_key", "awaiting")
        require_text(row["age_bucket"], f"{path}.age_bucket", 16, AGE_BUCKETS)
        expected_severity = "medium" if row["age_bucket"] in {"<30m", "30m-2h"} else "high"
        require_text(row["severity"], f"{path}.severity", 16, {expected_severity})
        require_bool(row["assigned"], f"{path}.assigned")
        require_bool(row["ai_disabled"], f"{path}.ai_disabled")
        require_bool(row["ai_handoff"], f"{path}.ai_handoff")
        require_text(row["status"], f"{path}.status", 16, {"open", "pending"})
        allowed_customer_signals = (
            MESSAGE_SIGNALS
            if row["ai_handoff"]
            else {"commercial_request", "frustration", "media", "other", "question"}
        )
        require_text(
            row["customer_signal"],
            f"{path}.customer_signal",
            24,
            allowed_customer_signals,
        )
        require_text(
            row["latest_content_type"],
            f"{path}.latest_content_type",
            24,
            CONTENT_TYPES,
        )
        require_reference(row["conversation_ref"], f"{path}.conversation_ref")
        validate_recent_messages(row["recent_messages"], f"{path}.recent_messages")
        require_content_signal(row["latest_content_type"], row["customer_signal"], path)
        if row["incident_key"] != "awaiting:" + row["conversation_ref"]:
            raise ValueError(f"El snapshot contiene una referencia inconsistente en {path}.")

    for index, value in enumerate(
        require_list(review["recent_interactions"], "customer_review.recent_interactions", 1)
    ):
        path = f"customer_review.recent_interactions[{index}]"
        row = require_exact_object(
            value,
            {
                "conversation_ref",
                "status",
                "assigned",
                "ai_disabled",
                "ai_handoff",
                "last_message_at",
                "latest_sender",
                "recent_messages",
            },
            path,
        )
        require_reference(row["conversation_ref"], f"{path}.conversation_ref")
        require_text(row["status"], f"{path}.status", 16, {"open", "pending"})
        require_bool(row["assigned"], f"{path}.assigned")
        require_bool(row["ai_disabled"], f"{path}.ai_disabled")
        require_bool(row["ai_handoff"], f"{path}.ai_handoff")
        require_timestamp(row["last_message_at"], f"{path}.last_message_at")
        require_text(row["latest_sender"], f"{path}.latest_sender", 16, SENDERS)
        validate_recent_messages(row["recent_messages"], f"{path}.recent_messages")
        latest = row["recent_messages"][0]
        if row["latest_sender"] != latest["sender"] or row["last_message_at"] != latest["at"]:
            raise ValueError(f"El snapshot contiene metadatos inconsistentes en {path}.")


def validate_message_incident(value, path, stale=False):
    fields = {
        "incident_key",
        "severity",
        "conversation_ref",
        "sender",
        "content_type",
        "ai_generated",
        "age_bucket",
        "at",
    }
    if stale:
        fields.add("delivery_status")
    else:
        fields.add("reason_code")
    row = require_exact_object(value, fields, path)
    prefix = "message-stale" if stale else "message-failed"
    require_incident_key(row["incident_key"], f"{path}.incident_key", prefix)
    require_text(
        row["severity"],
        f"{path}.severity",
        16,
        {"medium" if stale else "high"},
    )
    require_reference(row["conversation_ref"], f"{path}.conversation_ref")
    require_text(row["sender"], f"{path}.sender", 16, {"agent", "bot"})
    require_text(row["content_type"], f"{path}.content_type", 24, CONTENT_TYPES)
    require_bool(row["ai_generated"], f"{path}.ai_generated")
    require_text(row["age_bucket"], f"{path}.age_bucket", 16, AGE_BUCKETS)
    require_timestamp(row["at"], f"{path}.at")
    if stale:
        require_text(
            row["delivery_status"],
            f"{path}.delivery_status",
            16,
            {"sending", "sent"},
        )
    else:
        require_text(row["reason_code"], f"{path}.reason_code", 32, ERROR_CODES)


def validate_technical(value):
    technical = require_exact_object(value, TECHNICAL_FIELDS, "technical")
    for category in TECHNICAL_FIELDS:
        require_list(technical[category], f"technical.{category}", 1)

    for index, row in enumerate(technical["failed_messages"]):
        validate_message_incident(row, f"technical.failed_messages[{index}]")
    for index, row in enumerate(technical["stale_sent_messages"]):
        validate_message_incident(
            row, f"technical.stale_sent_messages[{index}]", stale=True
        )

    for index, value in enumerate(technical["automation_failures"]):
        path = f"technical.automation_failures[{index}]"
        row = require_exact_object(
            value,
            {
                "incident_key",
                "severity",
                "automation_ref",
                "error_code",
                "step_type",
                "occurrences",
                "latest_at",
            },
            path,
        )
        require_incident_key(
            row["incident_key"], f"{path}.incident_key", "automation-failed"
        )
        require_text(row["severity"], f"{path}.severity", 16, {"high"})
        require_reference(row["automation_ref"], f"{path}.automation_ref")
        require_text(row["error_code"], f"{path}.error_code", 32, ERROR_CODES)
        require_text(
            row["step_type"],
            f"{path}.step_type",
            32,
            AUTOMATION_STEP_TYPES,
            nullable=True,
        )
        require_count(row["occurrences"], f"{path}.occurrences", positive=True)
        require_timestamp(row["latest_at"], f"{path}.latest_at")

    for index, value in enumerate(technical["overdue_automation_executions"]):
        path = f"technical.overdue_automation_executions[{index}]"
        row = require_exact_object(
            value,
            {"incident_key", "severity", "automation_ref", "age_bucket", "run_at"},
            path,
        )
        require_incident_key(
            row["incident_key"], f"{path}.incident_key", "automation-overdue"
        )
        require_text(row["severity"], f"{path}.severity", 16, {"high"})
        require_reference(row["automation_ref"], f"{path}.automation_ref")
        require_text(row["age_bucket"], f"{path}.age_bucket", 16, AGE_BUCKETS)
        require_timestamp(row["run_at"], f"{path}.run_at")

    for index, value in enumerate(technical["flow_incidents"]):
        path = f"technical.flow_incidents[{index}]"
        if type(value) is not dict:
            raise ValueError(f"El snapshot contiene campos inválidos en {path}.")
        incident_key = value.get("incident_key")
        stalled = type(incident_key) is str and incident_key.startswith("flow-stalled:")
        fields = {
            "incident_key",
            "severity",
            "flow_ref",
            "reason_code",
            "conversation_ref",
        }
        if stalled:
            fields.add("age_bucket")
        row = require_exact_object(value, fields, path)
        require_incident_key(
            row["incident_key"],
            f"{path}.incident_key",
            "flow-stalled" if stalled else "flow-failed",
        )
        require_text(row["severity"], f"{path}.severity", 16, {"high"})
        require_reference(row["flow_ref"], f"{path}.flow_ref")
        require_text(row["reason_code"], f"{path}.reason_code", 32, ERROR_CODES)
        require_reference(
            row["conversation_ref"], f"{path}.conversation_ref", nullable=True
        )
        if stalled:
            require_text(row["age_bucket"], f"{path}.age_bucket", 16, AGE_BUCKETS)
            if row["reason_code"] != "timeout":
                raise ValueError(f"El snapshot contiene una razón inconsistente en {path}.")

    for index, value in enumerate(technical["webhook_incidents"]):
        path = f"technical.webhook_incidents[{index}]"
        row = require_exact_object(
            value,
            {
                "incident_key",
                "severity",
                "active",
                "consecutive_failures",
                "last_delivery_at",
            },
            path,
        )
        require_incident_key(row["incident_key"], f"{path}.incident_key", "webhook")
        require_bool(row["active"], f"{path}.active")
        require_text(
            row["severity"],
            f"{path}.severity",
            16,
            {"medium" if row["active"] else "high"},
        )
        require_count(
            row["consecutive_failures"],
            f"{path}.consecutive_failures",
            positive=row["active"],
            maximum=MAX_SAFE_INTEGER,
        )
        require_timestamp(
            row["last_delivery_at"], f"{path}.last_delivery_at", nullable=True
        )

    for index, value in enumerate(technical["whatsapp_incidents"]):
        path = f"technical.whatsapp_incidents[{index}]"
        row = require_exact_object(
            value,
            {
                "incident_key",
                "severity",
                "status",
                "has_registration_error",
            },
            path,
        )
        require_incident_key(row["incident_key"], f"{path}.incident_key", "whatsapp")
        require_text(row["status"], f"{path}.status", 16, WHATSAPP_STATUSES)
        require_bool(
            row["has_registration_error"], f"{path}.has_registration_error"
        )
        require_text(
            row["severity"],
            f"{path}.severity",
            16,
            {"medium" if row["status"] == "connected" else "critical"},
        )
        if row["status"] == "connected" and not row["has_registration_error"]:
            raise ValueError(f"El snapshot contiene un incidente imposible en {path}.")
        if row["status"] == "unknown" and row["has_registration_error"]:
            raise ValueError(f"El snapshot contiene un incidente imposible en {path}.")


def require_unique(values, path):
    if len(values) != len(set(values)):
        raise ValueError(f"El snapshot contiene identidades duplicadas en {path}.")


def validate_output_relations(root):
    review = root["customer_review"]
    technical = root["technical"]
    omitted = root["omitted"]
    metrics = root["metrics"]

    awaiting = review["awaiting_response"]
    recent = review["recent_interactions"]
    awaiting_refs = [row["conversation_ref"] for row in awaiting]
    recent_refs = [row["conversation_ref"] for row in recent]
    require_unique(awaiting_refs, "customer_review.awaiting_response")
    require_unique(recent_refs, "customer_review.recent_interactions")
    if set(awaiting_refs) & set(recent_refs):
        raise ValueError("El snapshot contiene conversaciones duplicadas entre revisiones.")

    incident_keys = [row["incident_key"] for row in awaiting]
    for category in TECHNICAL_FIELDS:
        incident_keys.extend(row["incident_key"] for row in technical[category])
    require_unique(incident_keys, "incident_key")

    visible = {
        "awaiting_response": len(awaiting),
        "recent_interactions": len(recent),
        **{category: len(technical[category]) for category in TECHNICAL_FIELDS},
    }
    caps = {"awaiting_response": 3, "recent_interactions": 1}
    caps.update({category: 1 for category in TECHNICAL_FIELDS})
    for category, count in visible.items():
        total = count + omitted[category]
        if total > OMISSION_LIMITS[category] or (
            omitted[category] > 0 and count != caps[category]
        ):
            raise ValueError(
                f"El snapshot contiene omisiones inconsistentes en {category}."
            )

    open_pending = metrics["open_conversations"] + metrics["pending_conversations"]
    review_candidates = (
        visible["awaiting_response"]
        + omitted["awaiting_response"]
        + visible["recent_interactions"]
        + omitted["recent_interactions"]
    )
    if review_candidates > open_pending or review_candidates > metrics["messages"]:
        raise ValueError("El snapshot contiene conteos inconsistentes en customer_review.")
    message_incidents = (
        visible["failed_messages"]
        + omitted["failed_messages"]
        + visible["stale_sent_messages"]
        + omitted["stale_sent_messages"]
    )
    if message_incidents > metrics["messages"]:
        raise ValueError("El snapshot contiene conteos inconsistentes en technical.")

    age_priority = {
        "<30m": 0,
        "30m-2h": 1,
        "2h-24h": 2,
        "1d-7d": 3,
        "7d+": 4,
    }

    def awaiting_priority(row):
        return (
            -int(row["ai_handoff"]),
            -age_priority[row["age_bucket"]],
            -CUSTOMER_SIGNAL_PRIORITY[row["customer_signal"]],
        )

    if any(
        awaiting_priority(left) > awaiting_priority(right)
        for left, right in zip(awaiting, awaiting[1:])
    ):
        raise ValueError(
            "El snapshot contiene un orden no canónico en awaiting_response."
        )


def validate_snapshot(snapshot):
    root = require_exact_object(snapshot, TOP_LEVEL_FIELDS, "raíz")
    if root["schema_version"] != 2 or type(root["schema_version"]) is not int:
        raise ValueError("El recolector devolvió un esquema no compatible.")
    privacy = require_exact_object(root["privacy"], PRIVACY_CONTRACT, "privacy")
    if any(
        type(privacy[key]) is not type(expected) or privacy[key] != expected
        for key, expected in PRIVACY_CONTRACT.items()
    ):
        raise ValueError("El recolector incumplió el contrato de privacidad.")

    metrics = require_exact_object(root["metrics"], METRIC_FIELDS, "metrics")
    for key, value in metrics.items():
        require_count(value, f"metrics.{key}")
    if metrics["open_conversations"] + metrics["pending_conversations"] > metrics[
        "conversations"
    ]:
        raise ValueError("El snapshot contiene conteos inconsistentes en metrics.")

    omitted = require_exact_object(root["omitted"], OMITTED_FIELDS, "omitted")
    for key, value in omitted.items():
        require_count(value, f"omitted.{key}", maximum=OMISSION_LIMITS[key])

    validate_customer_review(root["customer_review"])
    validate_technical(root["technical"])
    validate_output_relations(root)


def normalise_snapshot(raw: str, max_bytes: int = MAX_MONITOR_BYTES) -> str:
    try:
        snapshot = json.loads(
            raw,
            object_pairs_hook=reject_duplicate_members,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("constante JSON no estándar")
            ),
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError("El recolector no devolvió JSON válido.") from error
    validate_snapshot(snapshot)

    output = (
        json.dumps(
            snapshot,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    )
    if len(output.encode("utf-8")) > max_bytes:
        raise ValueError(
            "El snapshot excedió el límite seguro del monitor; cobertura desconocida."
        )
    return output


def require_secure_executable(path, label):
    try:
        file_stat = path.lstat()
    except OSError as error:
        raise FileNotFoundError(label) from error
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != 0
        or file_stat.st_mode & 0o022
        or not os.access(path, os.X_OK)
    ):
        raise ValueError(f"El ejecutable {label} no es confiable.")


def require_secure_node_executable(path=NODE_EXECUTABLE):
    require_secure_executable(path, "Node.js")


def require_secure_sandbox_profile(path=SANDBOX_PROFILE):
    try:
        file_stat = path.lstat()
    except OSError as error:
        raise FileNotFoundError("perfil sandbox") from error
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != os.getuid()
        or file_stat.st_mode & 0o022
        or path.resolve(strict=True) != path
    ):
        raise ValueError("El perfil sandbox no es confiable.")


def build_command():
    require_secure_node_executable()
    require_secure_executable(SANDBOX_EXECUTABLE, "sandbox-exec")
    require_secure_sandbox_profile()
    return [
        str(SANDBOX_EXECUTABLE),
        "-f",
        str(SANDBOX_PROFILE),
        str(NODE_EXECUTABLE),
        str(AUDIT_SCRIPT),
    ]


def _terminate_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def run_bounded_command(
    command,
    *,
    cwd,
    env,
    timeout_seconds,
    stdout_limit,
    stderr_limit,
    shell=False,
):
    if (
        shell is not False
        or type(command) is not list
        or not command
        or type(timeout_seconds) not in (int, float)
        or not 0 < timeout_seconds <= COLLECTOR_TIMEOUT_SECONDS
        or type(stdout_limit) is not int
        or stdout_limit < 1
        or type(stderr_limit) is not int
        or stderr_limit < 1
    ):
        raise ValueError("Los límites del subproceso son inválidos.")

    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            close_fds=True,
            start_new_session=True,
        )
    except OSError as error:
        raise ValueError("El recolector local no pudo ejecutarse.") from error

    streams = {
        "stdout": (process.stdout, stdout_limit),
        "stderr": (process.stderr, stderr_limit),
    }
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout_seconds
    try:
        for name, (stream, _limit) in streams.items():
            if stream is None:
                raise ValueError("El recolector local no pudo ejecutarse.")
            selector.register(stream, selectors.EVENT_READ, name)

        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            events = selector.select(remaining)
            if not events:
                raise TimeoutError
            for key, _mask in events:
                name = key.data
                remaining_bytes = streams[name][1] - len(buffers[name])
                chunk = os.read(key.fd, min(4_096, remaining_bytes + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    streams[name][0].close()
                    continue
                if len(chunk) > remaining_bytes:
                    raise BufferError
                buffers[name].extend(chunk)

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        return_code = process.wait(timeout=remaining)
    except TimeoutError as error:
        raise ValueError("El recolector local excedió su límite de tiempo.") from error
    except BufferError as error:
        raise ValueError("El recolector local excedió su límite de salida.") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("El recolector local no pudo ejecutarse.") from error
    finally:
        _terminate_process_group(process)
        selector.close()
        for stream, _limit in streams.values():
            if stream is not None and not stream.closed:
                stream.close()

    return subprocess.CompletedProcess(
        args=command,
        returncode=return_code,
        stdout=bytes(buffers["stdout"]),
        stderr=bytes(buffers["stderr"]),
    )


def collect_snapshot(run_impl=run_bounded_command):
    try:
        result = run_impl(
            build_command(),
            cwd=PROJECT_ROOT,
            env=SAFE_CHILD_ENV,
            timeout_seconds=COLLECTOR_TIMEOUT_SECONDS,
            stdout_limit=MAX_MONITOR_BYTES,
            stderr_limit=MAX_STDERR_BYTES,
            shell=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ValueError("El recolector local no pudo ejecutarse.") from error
    if result.returncode != 0:
        raise ValueError("El recolector local terminó con error.")
    if type(result.stdout) is not bytes or len(result.stdout) > MAX_MONITOR_BYTES:
        raise ValueError("El recolector local excedió su límite de salida.")
    try:
        raw = result.stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("El recolector no devolvió JSON válido.") from error
    return normalise_snapshot(raw)


def main() -> int:
    if not AUDIT_SCRIPT.is_file():
        print("[crm-auditor] No se encontró el recolector del CRM.", file=sys.stderr)
        return 1

    try:
        output = collect_snapshot()
    except ValueError as error:
        print(f"[crm-auditor] {error}", file=sys.stderr)
        return 1

    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

