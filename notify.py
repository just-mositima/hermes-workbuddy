"""Message push for the WorkBuddy check-in / travel runs.

The gateway already knows whether a claim or a dispatch happened; this module is
the "tell somebody" half — the part that is worthless inside a terminal nobody
is watching. Config lives in ``$HERMES_HOME/workbuddy/notify.json`` (never in a
skill directory, never in the repo), and every channel is optional.

Design rules, in order of importance:

1. **A push must never change the outcome.** Every channel is isolated: one
   failure is recorded and the next channel still runs; the caller's exit code
   never depends on this module.
2. **Off means off.** No config file → no push. ``enabled: false`` → no push.
   Success broadcasts need ``success_notify: true``; silence is the default.
3. **No secrets in output.** Only channel names and statuses are ever printed or
   logged — never a URL, token, or password.
4. **Paid channels stay skipped.** SMS-style channels are not implemented here:
   an unattended daily job must not be able to spend money.

Channels: ``webhook`` (generic JSON POST), ``dingtalk``, ``feishu``, ``wecom``,
``slack``, ``telegram``, ``bark``, ``email``, ``system`` (a local JSONL line).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import smtplib
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("hermes.plugins.workbuddy.notify")

CONFIG_NAME = "notify.json"
EXAMPLE_NAME = "notify.json.example"
LOG_NAME = "notify.jsonl"
TIMEOUT_SECONDS = 12.0

# Every key a channel may need, so `notify status` can say "unconfigured" rather
# than failing at send time.
REQUIRED: dict[str, tuple[str, ...]] = {
    "webhook": ("url",),
    "dingtalk": ("webhook",),
    "feishu": ("webhook",),
    "wecom": ("webhook",),
    "slack": ("webhook_url",),
    "telegram": ("bot_token", "chat_id"),
    "bark": ("device_key",),
    "email": ("smtp_host", "from", "to"),
    "system": (),
}

EXAMPLE = {
    "enabled": False,
    "success_notify": False,
    "channels": {
        "system": {},
        "webhook": {"url": "https://example.com/hook", "payload_template": "{\"text\": \"{{content}}\"}"},
        "dingtalk": {"webhook": "https://oapi.dingtalk.com/robot/send?access_token=...", "secret": ""},
        "feishu": {"webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/...", "secret": ""},
        "wecom": {"webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."},
        "slack": {"webhook_url": "https://hooks.slack.com/services/..."},
        "telegram": {"bot_token": "123:abc", "chat_id": "0"},
        "bark": {"server": "https://api.day.app", "device_key": "..."},
        "email": {
            "smtp_host": "smtp.example.com",
            "smtp_port": 465,
            "smtp_user": "me@example.com",
            "smtp_pass": "",
            "from": "me@example.com",
            "to": "me@example.com",
        },
    },
}


def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def state_dir() -> Path:
    return _home() / "workbuddy"


def config_path() -> Path:
    return state_dir() / CONFIG_NAME


def example_path() -> Path:
    return state_dir() / EXAMPLE_NAME


def log_path() -> Path:
    return state_dir() / LOG_NAME


def load_config() -> dict[str, Any]:
    try:
        document = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def write_example() -> str:
    path = example_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(json.dumps(EXAMPLE, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as error:
        return f"could not write {path}: {error}"
    return str(path)


# ── Channel plumbing ──────────────────────────────────────────────────


def _post_json(url: str, payload: Any) -> tuple[bool, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            text = response.read(400).decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        return False, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - a channel must never raise upward
        return False, type(error).__name__
    # Feishu/WeCom answer 200 with a business code; 0/ok means delivered.
    lowered = text.lower()
    if status >= 300:
        return False, f"HTTP {status}"
    if '"errcode":0' in text.replace(" ", "") or '"code":0' in text.replace(" ", ""):
        return True, "delivered"
    if '"ok"' in lowered and "false" not in lowered:
        return True, "delivered"
    if "errcode" in lowered or "code" in lowered:
        return False, _business_error(text)
    return True, "delivered"


def _business_error(text: str) -> str:
    try:
        document = json.loads(text)
    except ValueError:
        return "upstream refused"
    for key in ("errmsg", "msg", "message", "StatusMessage"):
        value = document.get(key)
        if isinstance(value, str) and value:
            return value[:120]
    return "upstream refused"


def _dingtalk_sign(webhook: str, secret: str) -> str:
    stamp = str(int(time.time() * 1000))
    digest = hmac.new(secret.encode("utf-8"), f"{stamp}\n{secret}".encode("utf-8"), hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(digest))
    joiner = "&" if "?" in webhook else "?"
    return f"{webhook}{joiner}timestamp={stamp}&sign={sign}"


def _send_webhook(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    template = channel.get("payload_template") or '{"text": "{{content}}"}'
    # JSON-escape the substituted values: a run summary is multi-line, and a raw
    # newline inside a JSON string makes the whole payload invalid (the receiver
    # then answers 400, which reads as "the channel is broken").
    payload = (
        str(template)
        .replace("{{title}}", json.dumps(title, ensure_ascii=False)[1:-1])
        .replace("{{content}}", json.dumps(content, ensure_ascii=False)[1:-1])
    )
    try:
        return _post_json(str(channel["url"]), json.loads(payload))
    except (KeyError, ValueError):
        return False, "bad url/payload_template"


def _send_dingtalk(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    webhook = str(channel.get("webhook") or "")
    secret = str(channel.get("secret") or "")
    if not webhook:
        return False, "unconfigured"
    if secret:
        webhook = _dingtalk_sign(webhook, secret)
    return _post_json(webhook, {"msgtype": "text", "text": {"content": f"{title}\n{content}"}})


def _send_feishu(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    webhook = str(channel.get("webhook") or "")
    if not webhook:
        return False, "unconfigured"
    payload: dict[str, Any] = {"msg_type": "text", "content": {"text": f"{title}\n{content}"}}
    secret = str(channel.get("secret") or "")
    if secret:
        stamp = str(int(time.time()))
        digest = hmac.new(f"{stamp}\n{secret}".encode("utf-8"), b"", hashlib.sha256).digest()
        payload["timestamp"] = stamp
        payload["sign"] = base64.b64encode(digest).decode("ascii")
    return _post_json(webhook, payload)


def _send_wecom(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    webhook = str(channel.get("webhook") or "")
    if not webhook:
        return False, "unconfigured"
    return _post_json(webhook, {"msgtype": "text", "text": {"content": f"{title}\n{content}"}})


def _send_slack(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    url = str(channel.get("webhook_url") or "")
    if not url:
        return False, "unconfigured"
    return _post_json(url, {"text": f"*{title}*\n{content}"})


def _send_telegram(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    token = str(channel.get("bot_token") or "")
    chat = str(channel.get("chat_id") or "")
    if not token or not chat:
        return False, "unconfigured"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    return _post_json(url, {"chat_id": chat, "text": f"{title}\n{content}"})


def _send_bark(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    key = str(channel.get("device_key") or "")
    if not key:
        return False, "unconfigured"
    server = str(channel.get("server") or "https://api.day.app").rstrip("/")
    return _post_json(f"{server}/push", {"device_key": key, "title": title, "body": content})


def _send_email(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    host = str(channel.get("smtp_host") or "")
    sender = str(channel.get("from") or "")
    to_raw = channel.get("to") or ""
    recipients = [str(to_raw)] if isinstance(to_raw, str) else [str(item) for item in to_raw]
    if not host or not sender or not recipients:
        return False, "unconfigured"
    port = int(channel.get("smtp_port") or 465)
    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message["Subject"] = title
    message.set_content(content)
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_SECONDS) as smtp:
                _smtp_login_and_send(smtp, channel, message)
        else:
            with smtplib.SMTP(host, port, timeout=TIMEOUT_SECONDS) as smtp:
                try:
                    smtp.starttls()
                except smtplib.SMTPException:
                    pass
                _smtp_login_and_send(smtp, channel, message)
    except Exception as error:  # noqa: BLE001
        return False, type(error).__name__
    return True, "delivered"


def _smtp_login_and_send(smtp: smtplib.SMTP, channel: dict[str, Any], message: EmailMessage) -> None:
    user = str(channel.get("smtp_user") or "")
    password = str(channel.get("smtp_pass") or "")
    if user:
        smtp.login(user, password)
    smtp.send_message(message)


def _send_system(channel: dict[str, Any], title: str, content: str) -> tuple[bool, str]:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "title": title, "content": content}
    try:
        log_path().parent.mkdir(parents=True, exist_ok=True)
        with log_path().open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as error:
        return False, f"log failed: {error}"
    return True, str(log_path())


SENDERS: dict[str, Callable[[dict[str, Any], str, str], tuple[bool, str]]] = {
    "webhook": _send_webhook,
    "dingtalk": _send_dingtalk,
    "feishu": _send_feishu,
    "wecom": _send_wecom,
    "slack": _send_slack,
    "telegram": _send_telegram,
    "bark": _send_bark,
    "email": _send_email,
    "system": _send_system,
}


def _channels(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Enabled channels, accepting both the nested and the flat legacy shape."""
    raw = config.get("channels")
    channels: dict[str, dict[str, Any]] = {}
    if isinstance(raw, dict):
        for name, value in raw.items():
            if isinstance(value, dict):
                channels[str(name)] = value
    # Flat aliases: the shape people paste from other skills' docs.
    for name, key in (("dingtalk", "dingtalk_webhook"), ("wecom", "wecom_webhook"), ("feishu", "feishu_webhook")):
        if name not in channels and isinstance(config.get(key), str) and config[key]:
            channels[name] = {"webhook": config[key]}
    if "system" not in channels and config.get("system_log", True):
        channels["system"] = {}
    return {name: body for name, body in channels.items() if body.get("enabled", True) is not False}


def readiness() -> list[tuple[str, bool, str]]:
    """``(channel, ready, detail)`` for every configured channel."""
    config = load_config()
    channels = _channels(config)
    rows: list[tuple[str, bool, str]] = []
    for name, body in sorted(channels.items()):
        needed = REQUIRED.get(name)
        if needed is None:
            rows.append((name, False, "unknown channel"))
            continue
        missing = [key for key in needed if not str(body.get(key) or "").strip()]
        if name == "bark" and str(body.get("bark_url") or "").strip():
            missing = []
        rows.append((name, not missing, "ready" if not missing else "missing " + ", ".join(missing)))
    return rows


def enabled() -> bool:
    config = load_config()
    return bool(config.get("enabled")) and bool(_channels(config))


def send(title: str, content: str, *, channels: Optional[list[str]] = None) -> list[tuple[str, str, str]]:
    """Push one message. Returns ``(channel, status, detail)`` rows; never raises."""
    config = load_config()
    targets = _channels(config)
    if channels:
        wanted = [name.strip().lower() for name in channels if name.strip()]
        targets = {name: body for name, body in targets.items() if name in wanted}
    results: list[tuple[str, str, str]] = []
    for name, body in sorted(targets.items()):
        sender = SENDERS.get(name)
        if sender is None:
            results.append((name, "unknown", "not a supported channel"))
            continue
        needed = REQUIRED.get(name, ())
        missing = [key for key in needed if not str(body.get(key) or "").strip()]
        if name == "bark" and str(body.get("bark_url") or "").strip():
            missing = []
        if missing:
            results.append((name, "unconfigured", ", ".join(missing)))
            continue
        try:
            ok, detail = sender(body, title, content)
        except Exception as error:  # noqa: BLE001 - isolation is the contract
            logger.debug("notify %s failed", name, exc_info=True)
            ok, detail = False, type(error).__name__
        results.append((name, "delivered" if ok else "failed", detail))
    return results


def notify_report(title: str, content: str, *, success: bool = True) -> str:
    """Push a run report when the config asks for it; render what happened."""
    config = load_config()
    if not config:
        return ""
    if not bool(config.get("enabled")):
        return ""
    if success and not bool(config.get("success_notify")):
        return ""
    results = send(title, content)
    if not results:
        return ""
    rendered = ", ".join(f"{name}={status}" for name, status, _detail in results)
    return f"notify: {rendered}"


def status_text() -> str:
    config = load_config()
    if not config:
        write_example()
    lines = [
        f"notify config: {config_path()}" + ("" if config else " (absent — pushing is off)"),
        f"  enabled: {'yes' if config.get('enabled') else 'no'}"
        f" · success_notify: {'yes' if config.get('success_notify') else 'no'}"
        f" · log: {log_path()}",
    ]
    rows = readiness()
    for name, ready, detail in rows:
        lines.append(f"  {name:<9} {detail}" + ("" if ready else " (not ready)"))
    if not rows:
        lines.append("  no channel configured — copy the example, fill one in, set enabled: true")
    lines.append(f"  template: {example_path()}")
    lines.append("  test:     hermes workbuddy notify test  ·  /workbuddy notify test")
    return "\n".join(lines)


def test_text() -> str:
    config = load_config()
    if not config:
        return f"no notify config at {config_path()} — run `hermes workbuddy notify status` for the template"
    results = send("WorkBuddy 推送测试 / push test", "If you can read this, the channel works.")
    if not results:
        return "nothing to send — no channel is configured"
    return "push test:\n" + "\n".join(f"  {name}: {status} ({detail})" for name, status, detail in results)


__all__ = [
    "config_path",
    "enabled",
    "load_config",
    "notify_report",
    "readiness",
    "send",
    "status_text",
    "test_text",
    "write_example",
]
