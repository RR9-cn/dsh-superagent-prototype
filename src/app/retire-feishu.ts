import type { TriggerDisposition } from '../core/index.ts'
import type { Store } from './store.ts'

const isFeishuThread = (thread: string): boolean => thread.startsWith('feishu:')

/** Run inside the schema upgrade transaction, before any effect handler can run. */
export function retireFeishu(store: Store): void {
  const { db } = store
  db.exec(`
    INSERT INTO effect (kind, key, value, seq, generation, attempts, error, due, since)
    SELECT 'hifox', ticket.id, json_object('ticketId', ticket.id),
      queued.seq, queued.generation, queued.attempts, queued.error, queued.due, queued.since
    FROM effect AS queued JOIN ticket ON ticket.id = queued.value ->> '$.ticketId'
    WHERE queued.kind IN ('launch', 'delivery') AND ticket.value ->> '$.executionTarget' = 'hifox'
    ORDER BY queued.due, queued.seq
    ON CONFLICT(kind, key) DO NOTHING;
    DELETE FROM effect WHERE kind IN ('launch', 'delivery');

    CREATE TEMP TABLE retired_feishu_trigger AS
      SELECT id FROM trigger WHERE value ->> '$.source' = 'feishu';
    CREATE TEMP TABLE retired_feishu_ticket AS
      SELECT id FROM ticket WHERE value ->> '$.mandate.actor.source' = 'feishu'
        OR value ->> '$.origin.triggerId' IN (SELECT id FROM retired_feishu_trigger);
    CREATE TEMP TABLE retired_feishu_decision AS
      SELECT id FROM decision WHERE thread GLOB 'feishu:*'
        OR value ->> '$.ticketId' IN (SELECT id FROM retired_feishu_ticket);
    CREATE TEMP TABLE retired_feishu_reply AS
      SELECT id FROM outbox WHERE value ->> '$.channel.source' = 'feishu'
        OR value ->> '$.ticketId' IN (SELECT id FROM retired_feishu_ticket);

    DELETE FROM effect WHERE
      (kind = 'reply' AND key IN (SELECT id FROM retired_feishu_reply)) OR
      (kind = 'assessment' AND (
        value ->> '$.triggerId' IN (SELECT id FROM retired_feishu_trigger) OR
        key IN (SELECT value ->> '$.evaluating.id' FROM thread WHERE key GLOB 'feishu:*')
      )) OR
      (kind = 'notice' AND (key GLOB 'subscription:feishu:*' OR key = 'settings:source:feishu')) OR
      (kind = 'relay' AND (
        CASE WHEN json_valid(value ->> '$.text') THEN
          (value ->> '$.text') ->> '$.trigger_id' IN (SELECT id FROM retired_feishu_trigger)
        ELSE 0 END
      ));
    DELETE FROM outbox WHERE id IN (SELECT id FROM retired_feishu_reply);
    DELETE FROM disposition WHERE id IN (SELECT id FROM retired_feishu_trigger);
    DELETE FROM trigger_thread WHERE thread GLOB 'feishu:*' OR id IN (SELECT id FROM retired_feishu_trigger);
    DELETE FROM trigger WHERE id IN (SELECT id FROM retired_feishu_trigger);
    DELETE FROM decision WHERE id IN (SELECT id FROM retired_feishu_decision);
    DELETE FROM kv WHERE key IN (
      SELECT 'session-prompts:worker-' || id FROM retired_feishu_ticket
    ) OR key GLOB 'feishu-*' OR key GLOB 'thread-seen:feishu:*' OR key GLOB 'thread-initialized:feishu:*'
      OR key IN ('source-labels:feishu', 'settings-block-revision:source:feishu');
    DELETE FROM ticket WHERE id IN (SELECT id FROM retired_feishu_ticket);
    UPDATE kv SET value = json_remove(value, '$.settings.sources.feishu', '$.settings.policy.sources.feishu')
      WHERE key GLOB 'settings-version:*';
  `)

  const ids = (table: 'trigger' | 'ticket' | 'decision') =>
    new Set(db.prepare(`SELECT id FROM retired_feishu_${table}`).all().map(row => String(row.id)))
  const triggers = ids('trigger'), tickets = ids('ticket'), decisions = ids('decision')
  const liveTrigger = (id: string): boolean => !triggers.has(id)
  const liveTicket = (id: string): boolean => !tickets.has(id)
  const removedThreads = db.prepare("DELETE FROM thread WHERE key GLOB 'feishu:*'").run().changes
  if (triggers.size || tickets.size || decisions.size || removedThreads) {
    for (const thread of store.threads.list()) {
      const original = JSON.stringify(thread)
      thread.correlated = thread.correlated.filter(key => !isFeishuThread(key))
      thread.subscriptions = thread.subscriptions.filter(liveTicket)
      if (thread.context) thread.context = thread.context.filter(liveTicket)
      thread.pending = thread.pending.filter(liveTrigger)
      const evaluation = thread.evaluating
      if (evaluation?.triggerIds.some(id => !liveTrigger(id))) {
        thread.pending = [...new Set([...evaluation.triggerIds.filter(liveTrigger), ...thread.pending])]
        db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(evaluation.id)
        delete thread.evaluating
      }
      if (JSON.stringify(thread) !== original) store.threads.save(thread)
    }
    for (const ticket of store.tickets.list()) {
      const original = JSON.stringify(ticket)
      ticket.channels = ticket.channels.filter(channel => channel.source !== 'feishu')
      if (ticket.follows) {
        ticket.follows = ticket.follows.filter(follow => !isFeishuThread(follow.thread))
        if (!ticket.follows.length) delete ticket.follows
      }
      ticket.origin.triggerIds = ticket.origin.triggerIds.filter(liveTrigger)
      ticket.inputs = ticket.inputs.filter(input => !('triggerId' in input) || liveTrigger(input.triggerId))
      const inputs = new Set(ticket.inputs.map(input => input.id))
      ticket.undelivered = ticket.undelivered.filter(id => inputs.has(id))
      if (ticket.attention?.triggerId && !liveTrigger(ticket.attention.triggerId)) delete ticket.attention.triggerId
      if (JSON.stringify(ticket) !== original) store.tickets.save(ticket)
    }
    const saveDisposition = db.prepare('UPDATE disposition SET value = ? WHERE id = ?')
    for (const row of db.prepare('SELECT id, value FROM disposition').all()) {
      const original = String(row.value)
      const disposition = JSON.parse(original) as TriggerDisposition
      disposition.fanout = disposition.fanout.filter(liveTicket)
      if (disposition.context) disposition.context = disposition.context.filter(liveTicket)
      if (disposition.acked) disposition.acked = disposition.acked.filter(liveTicket)
      if (disposition.handbacks) disposition.handbacks = disposition.handbacks.filter(item => liveTicket(item.ticketId))
      if (disposition.decisionId && decisions.has(disposition.decisionId)) delete disposition.decisionId
      const value = JSON.stringify(disposition)
      if (value !== original) saveDisposition.run(value, row.id!)
    }
  }
  db.exec(`
    DROP TABLE retired_feishu_reply;
    DROP TABLE retired_feishu_decision;
    DROP TABLE retired_feishu_ticket;
    DROP TABLE retired_feishu_trigger;
  `)
}
