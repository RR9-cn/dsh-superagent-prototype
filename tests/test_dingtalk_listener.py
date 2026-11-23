"""Offline tests for the staged DWS listener upgrade."""

import json
import pathlib
import runpy
import sqlite3
import tempfile
import unittest

BRIDGE = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "scripts/dingtalk-listener.py"))
MESSAGE = "请查资料不完整的具体原因"


class DingTalkListenerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.pilot = BRIDGE["Pilot"]("test-chat", self.root / "ding.sock")

    def open(self):
        db = BRIDGE["connect_db"](self.root)
        self.addCleanup(db.close)
        return db

    def event(self, message_id, **values):
        return dict({
            "type": "user_im_message_receive_at", "message_id": message_id, "conversation_id": "test-chat",
            "sender_open_dingtalk_id": "test-user", "sender": "Name", "create_time": "1795222800123",
            "content": MESSAGE,
        }, **values)

    def enqueue(self, db, message_id, **values):
        BRIDGE["enqueue"](db, json.dumps(self.event(message_id, **values)), self.pilot)

    def test_additive_migration_and_rollback_leave_old_and_pilot_records_on_their_own_routes(self):
        with sqlite3.connect(self.root / "messages.sqlite3") as legacy:
            legacy.executescript("""
                CREATE TABLE messages (message_id TEXT PRIMARY KEY, state TEXT NOT NULL);
                CREATE TABLE intake (message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
                    run_id TEXT, error TEXT, received_at INTEGER NOT NULL);
                INSERT INTO messages VALUES ('pre-listener', 'done');
                INSERT INTO intake VALUES ('existing', 'test-chat', 'queued', NULL, NULL, 1);
            """)
        db = self.open()
        for message_id in ("pre-listener", "existing", "pilot-queued"):
            self.enqueue(db, message_id)
        self.enqueue(db, "legacy-queued", conversation_id="routine-chat")
        self.enqueue(db, "pilot-manual", sender_open_dingtalk_id=None)
        # Rollback changes where only newly arriving rows go. Existing IDs are immutable in either setting.
        BRIDGE["enqueue"](db, json.dumps(self.event("pilot-queued")), None)
        BRIDGE["enqueue"](db, json.dumps(self.event("after-rollback")), None)
        self.assertEqual(db.execute("SELECT message_id, state, route FROM intake ORDER BY rowid").fetchall(), [
            ("existing", "queued", "legacy"), ("pilot-queued", "pilot_pending", "pilot"),
            ("legacy-queued", "queued", "legacy"), ("pilot-manual", "pilot_review", "pilot"),
            ("after-rollback", "queued", "legacy"),
        ])
        self.assertEqual(db.execute("SELECT message_id FROM intake WHERE state='queued' ORDER BY rowid").fetchall(),
                         [("existing",), ("legacy-queued",), ("after-rollback",)])

    def test_normalizes_dws_fields_and_quarantines_ambiguous_input(self):
        db = self.open()
        self.enqueue(db, "root")
        self.enqueue(db, "follow", content="补充线索", quoted_message={"conversation_id": "test-chat", "message_id": "root"})
        errors = (
            ("wrong-chat", {"quoted_message": {"conversation_id": "other-chat", "message_id": "root"}}, "invalid_reference_scope"),
            ("missing-quote-chat", {"quoted_message": {"message_id": "root"}}, "invalid_reference_scope"),
            ("wrong-sender", {"sender_open_dingtalk_id": ""}, "missing_sender"),
            ("forward", {"forward_messages": [{"content": MESSAGE}]}, "forwarded_message"),
            ("naive-date", {"create_time": "2026-11-21 09:00:00"}, "invalid_time"),
        )
        for message_id, fields, _ in errors:
            self.enqueue(db, message_id, **fields)
        root, follow = [json.loads(row[0]) for row in db.execute("SELECT payload FROM intake WHERE state='pilot_pending' ORDER BY rowid")]
        self.assertEqual(root["senderId"], "test-user")
        self.assertEqual(root["at"], "2026-11-21T01:00:00.123000Z")
        self.assertEqual(root["text"], MESSAGE)
        self.assertNotIn("request", root)
        self.assertEqual(follow["replyToMessageId"], "root")
        self.assertNotIn("request", follow)
        self.assertEqual(db.execute("SELECT message_id,error FROM intake WHERE state='pilot_review' ORDER BY rowid").fetchall(),
                         [(message_id, error) for message_id, _, error in errors])

    def test_retries_unchanged_payload_and_endpoint_in_arrival_order_without_legacy_fallback(self):
        db = self.open()
        self.enqueue(db, "z-root")
        self.enqueue(db, "a-follow", content="补充", quoted_message={"conversation_id": "test-chat", "message_id": "z-root"})
        dispatch = BRIDGE["dispatch_pilot"]
        sends = []

        def disconnect(endpoint, payload):
            sends.append((endpoint, payload))
            raise BRIDGE["Retry"]("socket_unavailable")

        dispatch(db, disconnect, clock=lambda: 0)
        dispatch(db, disconnect, clock=lambda: 1)
        self.assertEqual(len(sends), 1)
        restarted = self.open()
        new_pilot = BRIDGE["Pilot"]("test-chat", self.root / "different.sock")
        BRIDGE["enqueue"](restarted, json.dumps(self.event("z-root", content="改写的内容")), new_pilot)

        def dedup(endpoint, payload):
            sends.append((endpoint, payload))

        dispatch(restarted, dedup, clock=lambda: 10)
        dispatch(restarted, dedup, clock=lambda: 10)
        self.assertEqual(sends[0], sends[1])
        self.assertEqual(json.loads(sends[2][1])["messageId"], "a-follow")
        self.assertEqual(restarted.execute("SELECT state,payload FROM intake").fetchall(),
                         [("pilot_delivered", None), ("pilot_delivered", None)])

    def test_declined_message_is_not_attempted_again(self):
        db = self.open()
        self.enqueue(db, "rejected")
        calls = []

        def reject(endpoint, payload):
            calls.append((endpoint, payload))
            raise BRIDGE["Review"]("sender_not_allowed")

        for _ in range(2):
            BRIDGE["dispatch_pilot"](db, reject)
        self.assertEqual(len(calls), 1)
        self.assertEqual(db.execute("SELECT state,error,payload FROM intake").fetchone(),
                         ("pilot_review", "sender_not_allowed", None))


if __name__ == "__main__":
    unittest.main()
