#!/usr/bin/env python3
"""Staged replacement for the launchd-managed DWS @me listener.

Set DINGTALK_BRIDGE_DWS_PROFILE, DINGTALK_BRIDGE_LEGACY_TASK, and
DINGTALK_BRIDGE_LEGACY_AGENT to the existing service's settings. The default
DINGTALK_BRIDGE_STATE_DIR is ~/.local/share/dingtalk-hifox-bridge and must
be owned by the current account with mode 0700. DINGTALK_BRIDGE_DWS and
DINGTALK_BRIDGE_HIFOX optionally override the installed CLI paths.

Enable pilot routing for new events by setting DINGTALK_BRIDGE_PILOT_CONVERSATION,
and an absolute DINGTALK_BRIDGE_PILOT_SOCKET pointing
to the private Runtime state directory's ding.sock. Remove both variables
to resume legacy routing for new events. Existing pilot rows keep their saved
route, payload and endpoint across restarts, including with the pilot disabled.
"""

import fcntl
import json
import os
import re
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

TYPE = "user_im_message_receive_at"
NATIVE_ID = re.compile(r"[\w:@.+=/-]{1,160}", re.ASCII)
RFC3339 = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})"
MAX_REQUEST_BYTES = 32 * 1024
MAX_REPLY_BYTES = 1024
MANUAL_RESULTS = {
    "invalid_message", "outside_pilot", "sender_not_allowed", "unknown_reference",
    "conflicting_reference", "missing_request",
}


@dataclass(frozen=True)
class Pilot:
    conversation_id: str
    socket_path: Path


@dataclass(frozen=True)
class Config:
    state_dir: Path
    dws: str
    hifox: str
    profile: str
    legacy_task: str
    legacy_agent: str
    pilot: Optional[Pilot]

    @classmethod
    def from_environment(cls):
        home = Path.home()
        env = os.environ
        prefix = "DINGTALK_BRIDGE_"
        profile, task, agent = (env.get(prefix + key, "") for key in ("DWS_PROFILE", "LEGACY_TASK", "LEGACY_AGENT"))
        if not all(native_id(value) for value in (profile, task, agent)):
            raise ValueError("Configure DINGTALK_BRIDGE_DWS_PROFILE, DINGTALK_BRIDGE_LEGACY_TASK and DINGTALK_BRIDGE_LEGACY_AGENT")
        chat, endpoint = (env.get(prefix + key, "") for key in ("PILOT_CONVERSATION", "PILOT_SOCKET"))
        pilot = None
        if chat or endpoint:
            max_socket_path = 103 if sys.platform == "darwin" else 107
            if (not native_id(chat) or not Path(endpoint).is_absolute()
                    or "\0" in endpoint or len(os.fsencode(endpoint)) > max_socket_path):
                raise ValueError("Configure the pilot conversation and its absolute socket path")
            pilot = Pilot(chat, Path(endpoint))
        return cls(
            state_dir=Path(env.get(prefix + "STATE_DIR", str(home / ".local/share/dingtalk-hifox-bridge"))),
            dws=env.get(prefix + "DWS", str(home / ".npm-global/bin/dws")),
            hifox=env.get(prefix + "HIFOX", str(home / ".local/bin/hifox")),
            profile=profile, legacy_task=task, legacy_agent=agent, pilot=pilot,
        )


class Review(Exception):
    """Known input or intake rejection safe to persist without private event data."""


class Retry(Exception):
    """A delivery outcome is unavailable; retain the same payload for a later attempt."""


def log(message):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), message, flush=True)


def native_id(value):
    return isinstance(value, str) and bool(NATIVE_ID.fullmatch(value))


def normalize_time(value):
    # DWS timestamps are commonly epoch seconds or milliseconds, with either JSON integer or string encoding.
    try:
        if type(value) is int:
            value = str(value)
        if isinstance(value, str):
            if re.fullmatch(r"[0-9]{10}", value):
                value = datetime.fromtimestamp(int(value), tz=timezone.utc)
            elif re.fullmatch(r"[0-9]{13}", value):
                seconds, millis = divmod(int(value), 1000)
                value = datetime.fromtimestamp(seconds, tz=timezone.utc).replace(microsecond=millis * 1000)
            elif re.fullmatch(RFC3339, value):
                value = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
            else:
                raise Review("invalid_time")
            return value.isoformat().replace("+00:00", "Z")
    except (ValueError, OSError, OverflowError) as exc:
        raise Review("invalid_time") from exc
    raise Review("invalid_time")


def pilot_message(event, pilot):
    sender, body = event.get("sender_open_dingtalk_id"), event.get("content")
    if not native_id(sender):
        raise Review("missing_sender")
    if not isinstance(body, str) or not body.strip():
        raise Review("invalid_content")
    body = body.strip()
    try:
        if len(body.encode("utf-16-le")) > 8000:
            raise Review("invalid_content")
    except UnicodeError as exc:
        raise Review("invalid_content") from exc
    # Only the DWS event's own content provides a work order. Forwarded records are not ingress.
    if event.get("forward_messages"):
        raise Review("forwarded_message")
    try:
        at = normalize_time(event.get("create_time"))
    except Review:
        at = normalize_time(event.get("event_time"))
    message = {
        "conversationId": event["conversation_id"], "messageId": event["message_id"],
        "senderId": sender, "human": True, "at": at,
        "addressed": "mention", "text": body,
    }
    quote = event.get("quoted_message")
    if quote is not None:
        if not isinstance(quote, dict) or not native_id(quote.get("message_id")):
            raise Review("invalid_reference")
        if quote.get("conversation_id") != pilot.conversation_id:
            raise Review("invalid_reference_scope")
        if quote["message_id"] == message["messageId"]:
            raise Review("invalid_reference")
        message["replyToMessageId"] = quote["message_id"]
    return message


def connect_db(state_dir):
    db = sqlite3.connect(state_dir / "messages.sqlite3", timeout=30)
    try:
        # Serialize additive migration before either worker reads the original tables.
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY, state TEXT NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS intake (
                message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
                run_id TEXT, error TEXT, received_at INTEGER NOT NULL
            )""")
            columns = {col[1] for col in db.execute("PRAGMA table_info(intake)")}
            for name, definition in (
                ("route", "TEXT NOT NULL DEFAULT 'legacy'"),
                ("payload", "TEXT"),
                ("endpoint", "TEXT"),
                ("attempts", "INTEGER NOT NULL DEFAULT 0"),
                ("retry_at", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if name not in columns:
                    db.execute(f"ALTER TABLE intake ADD COLUMN {name} {definition}")
    except Exception:
        db.close()
        raise
    return db


def enqueue(db, line, pilot):
    event = json.loads(line)
    if not isinstance(event, dict) or event.get("type") != TYPE:
        return
    message_id, conversation_id = event.get("message_id"), event.get("conversation_id")
    if not native_id(message_id) or not native_id(conversation_id):
        log("ignored event without a stable message and conversation ID")
        return
    selected = pilot is not None and conversation_id == pilot.conversation_id
    route, state, payload, endpoint, error = "legacy", "queued", None, None, None
    if selected:
        # Distinct states also keep a pilot receipt out of a rolled-back legacy worker's queued selection.
        route, state, endpoint = "pilot", "pilot_pending", str(pilot.socket_path)
        try:
            payload = json.dumps(pilot_message(event, pilot), ensure_ascii=False, separators=(",", ":"))
        except Review as exc:
            state, error = "pilot_review", str(exc)
    with db:
        inserted = db.execute("""INSERT INTO intake
            (message_id, conversation_id, state, received_at, route, payload, endpoint, error)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM messages WHERE message_id = ?)
            ON CONFLICT(message_id) DO NOTHING""",
            (message_id, conversation_id, state, int(time.time()), route, payload, endpoint, error, message_id))
    if inserted.rowcount:
        log(f"recorded {route} event: {state}" + (f" ({error})" if error else ""))


def run(args, *, stdin=None):
    result = subprocess.run(args, input=stdin, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("hifox_command_failed")
    return json.loads(result.stdout)


def triage_prompt(message_id, conversation_id):
    return f"""钉钉 @我消息分流。只处理下面这一条触发消息。
conversation_id: {conversation_id}
message_id: {message_id}

请用已授权的 dws 命令读取该消息、引用消息及同一会话附近的必要上下文。附件正文无法读取时不要猜。先检查 FSHO 中是否已有同一事项。判断结果仅限 CREATE（明确的新工作）、UPDATE（已有工作的补充或进度）、IGNORE（寒暄、确认、已解决、仅知会）、REVIEW（证据不足）。

只有明确需要当前用户处理或持续跟进且尚未完成时才创建新任务。同一事项优先更新或关联原任务。创建或更新时给出明确动作、当前进展和钉钉来源 ID，避免复制无关或敏感原文。不要向钉钉发送消息。若无法读取上下文，选择 REVIEW。最后用一行 `DECISION: <类别>；task=<标识或无>；reason=<简短理由>` 回答。"""


def dispatch_legacy(db, config):
    active = db.execute("""SELECT message_id,run_id FROM intake
        WHERE route='legacy' AND state='dispatched' ORDER BY received_at LIMIT 1""").fetchone()
    if active:
        message_id, run_id = active
        status = run([config.hifox, "run", "view", run_id, "--output", "json"]).get("status")
        if status in ("completed", "complete", "succeeded"):
            state, error = "done", None
        elif status in ("failed", "cancelled", "canceled", "error"):
            state, error = "needs_review", status
        else:
            return
        with db:
            db.execute("UPDATE intake SET state=?,error=? WHERE message_id=?", (state, error, message_id))
        log(f"legacy agent run: {state}")
    row = db.execute("""SELECT message_id,conversation_id FROM intake
        WHERE route='legacy' AND state='queued' ORDER BY received_at,message_id LIMIT 1""").fetchone()
    if not row:
        return
    message_id, conversation_id = row
    with db:
        claimed = db.execute("""UPDATE intake SET state='summoning'
            WHERE message_id=? AND route='legacy' AND state='queued'""", (message_id,))
    if not claimed.rowcount:
        return
    try:
        data = run([config.hifox, "task", "summon", config.legacy_task, "--agent", config.legacy_agent,
                    "--body-stdin", "--output", "json"], stdin=triage_prompt(message_id, conversation_id))
        run_id = data.get("runId")
        if not native_id(run_id):
            raise RuntimeError("legacy_run_id_missing")
    except (ValueError, AttributeError, RuntimeError, OSError, subprocess.TimeoutExpired):
        with db:
            db.execute("UPDATE intake SET state='needs_review',error='legacy_summon_uncertain' WHERE message_id=?", (message_id,))
        log("legacy summon needs review")
        return
    with db:
        db.execute("UPDATE intake SET state='dispatched',run_id=? WHERE message_id=?", (run_id, message_id))
    log("summoned legacy agent for @me event")


def private_path(path, kind):
    info = path.lstat()
    return kind(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0


def socket_delivery(endpoint, payload):
    raw = payload.encode("utf-8")
    if len(raw) > MAX_REQUEST_BYTES:
        raise Review("invalid_message")
    address = Path(endpoint)
    try:
        if not private_path(address.parent, stat.S_ISDIR) or not private_path(address, stat.S_ISSOCK):
            raise Retry("socket_permissions")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            deadline = time.monotonic() + 5
            client.settimeout(5)
            client.connect(endpoint)
            client.settimeout(max(0.001, deadline - time.monotonic()))
            client.sendall(raw)
            client.shutdown(socket.SHUT_WR)
            reply = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Retry("socket_timeout")
                client.settimeout(remaining)
                chunk = client.recv(MAX_REPLY_BYTES)
                if not chunk:
                    break
                reply.extend(chunk)
                if len(reply) > MAX_REPLY_BYTES:
                    raise Retry("invalid_reply")
        decoded = json.loads(reply.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise Retry("socket_unavailable") from exc
    if not isinstance(decoded, dict):
        raise Retry("invalid_reply")
    result = decoded.get("result")
    if result in ("stored", "duplicate"):
        return
    if result == "filtered":
        raise Review("filtered")
    if isinstance(result, dict) and isinstance(result.get("manual"), str) and result["manual"] in MANUAL_RESULTS:
        raise Review(result["manual"])
    raise Retry("invalid_reply")


def dispatch_pilot(db, deliver=socket_delivery, clock=time.time):
    # DWS insertion order keeps quoted follow-ups behind an earlier receipt awaiting confirmation.
    row = db.execute("""SELECT message_id, payload, endpoint, attempts, retry_at FROM intake
        WHERE route='pilot' AND state='pilot_pending' ORDER BY rowid LIMIT 1""").fetchone()
    if not row:
        return
    message_id, payload, endpoint, attempts, retry_at = row
    now = int(clock())
    if retry_at > now:
        return
    try:
        deliver(endpoint, payload)
    except Retry as exc:
        delay = min(300, 2 ** min(attempts + 2, 9))
        with db:
            db.execute("""UPDATE intake SET attempts = attempts + 1, retry_at = ?, error = ?
                WHERE message_id = ? AND state = 'pilot_pending'""", (now + delay, str(exc), message_id))
        log(f"pilot handoff pending: {exc}")
        return
    except Review as exc:
        state, error = "pilot_review", str(exc)
    else:
        state, error = "pilot_delivered", None
    with db:
        db.execute("""UPDATE intake SET state=?,error=?,payload=NULL
            WHERE message_id=? AND state='pilot_pending'""", (state, error, message_id))
    log(f"pilot handoff: {state}" + (f" ({error})" if error else ""))


def worker(config, stopping, route):
    with closing(connect_db(config.state_dir)) as db:
        legacy_ready = False
        while not stopping.is_set():
            try:
                if route == "pilot":
                    dispatch_pilot(db)
                elif db.execute("""SELECT 1 FROM intake WHERE route='legacy'
                        AND state IN ('queued','dispatched') LIMIT 1""").fetchone():
                    if not legacy_ready:
                        status = run([config.hifox, "auth", "status", "--output", "json"])
                        if not status.get("authenticated") or status.get("authMode") != "user":
                            raise RuntimeError("legacy_hifox_user_auth_required")
                        legacy_ready = True
                    if not stopping.is_set():
                        dispatch_legacy(db, config)
            except Exception as exc:
                log(f"{route} worker unavailable: {type(exc).__name__}")
            stopping.wait(10 if route == "legacy" else 2)


def listen(config):
    db = connect_db(config.state_dir)
    stopping, ready = threading.Event(), threading.Event()
    child = None

    def stop(_signum, _frame):
        stopping.set()
        ready.set()
        if child and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        child = subprocess.Popen([config.dws, "event", "+listen-im", "--kind", "at-me",
                                  "--profile", config.profile, "--format", "ndjson"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

        def drain_stderr():
            for line in child.stderr:
                if f"[event] ready event_key={TYPE} " in line:
                    ready.set()

        threading.Thread(target=drain_stderr, daemon=True).start()
        if not ready.wait(60):
            raise RuntimeError("DWS did not report @me ready within 60 seconds")
        if stopping.is_set():
            return
        for route in ("legacy", "pilot"):
            threading.Thread(target=worker, args=(config, stopping, route), daemon=True).start()
        log("ready: @me events queue into the configured routes")
        for line in child.stdout:
            if stopping.is_set():
                break
            try:
                enqueue(db, line, config.pilot)
            except (ValueError, sqlite3.Error) as exc:
                log(f"event rejected: {type(exc).__name__}")
        if not stopping.is_set():
            raise RuntimeError("DWS stream ended unexpectedly")
    finally:
        stopping.set()
        for signal_name in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signal_name, signal.SIG_IGN)
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        db.close()


def main():
    os.umask(0o077)
    config = Config.from_environment()
    config.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not private_path(config.state_dir, stat.S_ISDIR):
        raise ValueError("Listener state requires a private same-account directory")
    with (config.state_dir / "listener.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        listen(config)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        log("fatal: " + str(exc))
        sys.exit(1)
