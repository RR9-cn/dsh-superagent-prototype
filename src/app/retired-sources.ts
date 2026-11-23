import type { Engine } from '../core/index.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import { retiredSource } from '../sources/kind.ts'

/** Close historical work and settle its outbound work before the upgraded runtime starts dispatching. */
export function retireSources(store: Store, engine: Pick<Engine, 'stopTicket'>, effects: Effects): void {
  store.atomic(() => {
    const stopped = new Set<string>()
    for (const ticket of store.tickets.open()) {
      const origin = store.triggers.get(ticket.origin.triggerId)
      if (retiredSource(origin?.source ?? ticket.mandate.actor.source)) {
        engine.stopTicket(ticket.id, 'The originating source was removed.')
        stopped.add(ticket.id)
        for (const assignment of ticket.assignments) effects.cancel('launch', assignment.id)
        effects.cancel('delivery', ticket.id)
        continue
      }
      const follows = ticket.follows?.filter(item => !retiredSource(item.thread.split(':', 1)[0] ?? ''))
      if (follows && follows.length !== ticket.follows!.length) {
        // Keep the old channel and thread records for history, but never wait for another update from that source.
        if (follows.length) ticket.follows = follows
        else delete ticket.follows
        store.tickets.save(ticket)
      }
    }
    for (const thread of store.threads.active()) {
      if (!retiredSource(thread.ref.source)) continue
      if (thread.evaluating) effects.cancel('assessment', thread.evaluating.id)
      thread.pending = []
      delete thread.evaluating
      delete thread.expired
      store.threads.save(thread)
    }
    for (const receipt of store.receipts.waiting()) {
      if (!retiredSource(receipt.channel.source) && !stopped.has(receipt.ticketId ?? '')) continue
      store.receipts.settle(receipt, 'channelGone')
      effects.cancel('reply', receipt.id)
    }
  })
}
