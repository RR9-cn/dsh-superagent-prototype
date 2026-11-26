import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, KeyValues, Section, When } from './widgets.tsx'

type DreamingView = ApiResponse<'GET dreaming'>
type Batch = DreamingView['batches'][number]
type Evidence = Batch['pack']['evidence'][number]
type Duplicate = NonNullable<DreamingView['duplicates']>['pairs'][number]

function EvidenceList({ items }: { items: Evidence[] }) {
  return <ul className="dt-list">{items.map(item => <li className="dt-row" key={item.id}>
    <details><summary>{item.source}</summary><p>{item.text}</p></details>
  </li>)}</ul>
}

function MemoryCorrection({ batch, reload, editorId }: {
  batch: Extract<Batch, { candidate: unknown }>; reload: () => Promise<void>; editorId: string
}) {
  const { t, call } = usePanel()
  const { id, candidate } = batch
  const edit = candidate.memory
  const initialQuery = candidate.after.title.slice(0, 500)
  const editor = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [request, setRequest] = useState(() => edit ? undefined : { query: initialQuery })
  const [search, setSearch] = useState<{ request: typeof request; options?: ApiResponse<'POST dreaming/batches/:id/memory/find'>; error?: string }>()
  const [target, setTarget] = useState<ApiResponse<'POST dreaming/batches/:id/memory/read'>>()
  const [previous, setPrevious] = useState('')
  const [replacement, setReplacement] = useState(() => {
    const sources = batch.pack.evidence.filter(item => candidate.after.support.includes(item.id)).map(item => `- ${item.source}`)
    return [candidate.after.action, candidate.after.verification, ...sources].join('\n\n')
  })
  useEffect(() => { editor.current?.scrollIntoView?.({ block: 'nearest' }) }, [])
  useEffect(() => {
    if (!request) return
    let active = true
    void call('POST dreaming/batches/:id/memory/find', { id, body: request }).then(options => {
      if (active) setSearch({ request, options })
    }, error => {
      if (active) setSearch({ request, error: errorText(error) })
    })
    return () => { active = false }
  }, [call, id, request])
  const searching = !!request && search?.request !== request
  const options = searching ? undefined : search?.options
  const read = useAction(async (uri: string) => {
    setTarget(await call('POST dreaming/batches/:id/memory/read', { id, body: { uri } }))
    setPrevious('')
  })
  const stage = useAction(async () => {
    if (!target) return
    await call('PUT dreaming/batches/:id/memory', { id, body: { uri: target.uri, digest: target.digest, previous, replacement, query } })
    setTarget(undefined)
  }, { reload })
  const write = useAction(() => call('POST dreaming/batches/:id/memory/write', { id }), { reload })
  const locked = edit && ['writing', 'pending_verification', 'verified'].includes(edit.status)
  return <div id={editorId} ref={editor}>
    {!edit && <Hint>{t('dreaming.memorySteps')}</Hint>}
    {!locked && <>
      <form className="dt-form" onSubmit={event => { event.preventDefault(); setRequest({ query: query.trim() }) }}>
        <Input aria-label={t('dreaming.findMemory')} maxLength={500} value={query} onChange={event => setQuery(event.target.value)} />
        <Button size="sm" type="submit" disabled={searching || !query.trim()}>{t('dreaming.findMemory')}</Button>
      </form>
      {searching && <p role="status" className="dt-hint">{t('dreaming.findingMemory')}</p>}
      {!searching && search?.error && <p className="dt-error" role="alert">{search.error}</p>}
    </>}
    {!locked && options && (options.length ? <ul className="dt-list">{options.map(item => <li key={item.uri} className="dt-row">
      <div className="dt-row-main"><button type="button" className="dt-open" disabled={read.busy} onClick={() => { void read.run(item.uri) }}>{item.uri}</button>
        <Hint>{item.excerpt}</Hint></div>
    </li>)}</ul> : <Hint>{t('dreaming.noMemoryMatches')}</Hint>)}
    {!locked && target && <div className="dt-form">
      <p>{target.uri}</p>
      <label>{t('dreaming.memoryOriginal')}<textarea readOnly rows={8} value={target.content} /></label>
      <label>{t('dreaming.memoryPrevious')}<textarea className="dt-input" rows={3} maxLength={12000} value={previous}
        onChange={event => setPrevious(event.target.value)} /></label>
      <label>{t('dreaming.memoryReplacement')}<textarea className="dt-input" rows={5} maxLength={12000} value={replacement}
        onChange={event => setReplacement(event.target.value)} /></label>
      <Button size="sm" disabled={stage.busy || !query.trim() || !previous.trim() || !replacement.trim()}
        onClick={() => { void stage.run() }}>{t('dreaming.stageMemory')}</Button>
    </div>}
    {edit && <>
      <KeyValues rows={[[t('dreaming.memoryTarget'), edit.uri], [t('dreaming.memoryPrevious'), edit.previous],
        [t('dreaming.memoryReplacement'), edit.replacement]]} />
      <p role="status">{t(`dreaming.memory.${edit.status}`)} {edit.error}</p>
      {edit.status !== 'verified' && <Button size="sm" variant="primary"
        disabled={write.busy || edit.status === 'conflict' || candidate.review !== 'approved'}
        onClick={() => { void write.run() }}>{t('dreaming.commitMemory')}</Button>}
    </>}
  </div>
}

function DuplicateReview({ pair, reload }: { pair: Duplicate; reload: () => Promise<void> }) {
  const { call, t, notify } = usePanel()
  const [confirming, setConfirming] = useState(false)
  const remove = useAction(async () => {
    try {
      const result = await call('POST dreaming/duplicates/:id/remove', { id: pair.id })
      if (result.status === 'proposed') notify(t('dreaming.duplicateDeleteRetry'))
    } finally {
      setConfirming(false)
      await reload()
    }
  })
  const actionable = pair.status === 'proposed' || pair.status === 'deleting'
  return <li className="dt-row">
    <KeyValues rows={[[t('dreaming.duplicateKeep'), pair.keep.uri], [t('dreaming.duplicateRemove'), pair.remove.uri]]} />
    <Hint>{t(`dreaming.duplicateReason.${pair.reason}`)}</Hint>
    {pair.obsolete.length > 0 && <details><summary>{t('dreaming.duplicateObsolete')}</summary>
      {pair.obsolete.map((fragment, index) => <p key={index}>{fragment}</p>)}
    </details>}
    <p role="status">{t(`dreaming.duplicateStatus.${pair.status}`)}</p>
    {actionable && (confirming ? <>
      <p>{t('dreaming.duplicateConfirmCopy')}</p>
      <div className="dt-row-buttons">
        <Button size="sm" variant="primary" disabled={remove.busy} onClick={() => { void remove.run() }}>{t('dreaming.duplicateConfirm')}</Button>
        <Button size="sm" disabled={remove.busy} onClick={() => setConfirming(false)}>{t('cancel')}</Button>
      </div>
    </> : <Button size="sm" disabled={remove.busy} onClick={() => setConfirming(true)}>{t('dreaming.duplicateReview')}</Button>)}
    {pair.status === 'pending_verification' && <Button size="sm" disabled={remove.busy}
      onClick={() => { void remove.run() }}>{t('dreaming.duplicateVerify')}</Button>}
  </li>
}

function BatchReview({ batch, reload, openViking }: { batch: Batch; reload: () => Promise<void>; openViking?: true }) {
  const { t, call, openSession, notify } = usePanel()
  const action = useAction(async (review: 'approved' | 'rejected' | 'pending' | 'publish') => {
    if (review === 'publish') await call('POST dreaming/batches/:id/publish', { id: batch.id })
    else await call('PUT dreaming/batches/:id/review', { id: batch.id, body: { review } })
  }, { reload })
  const candidate = 'candidate' in batch ? batch.candidate : undefined
  const automatic = useAction(async () => {
    try { await call('POST dreaming/batches/:id/memory/correct', { id: batch.id }) }
    finally { await reload() }
  })
  const [showEditor, setShowEditor] = useState(false)
  const target = batch.pack.target
  const audit = candidate?.audit
  const canCorrect = openViking && !!candidate && (target ? audit?.outcome === 'revise' : !batch.pack.archiveUri)
  const editorId = `dreaming-memory-${batch.id}`
  const match = candidate?.memoryMatch
  const checkStatus = match?.status === 'failed' && match.stage
    ? t(`dreaming.memoryMatch.failure.${match.stage}`)
    : match && t(`dreaming.memoryMatch.${match.status}`)
  const edit = candidate?.memory
  const memoryIssue = match?.errorCode ?? edit?.errorCode
  const unsafeWrite = memoryIssue === 'unsafe_uri' || memoryIssue === 'redirected_uri'
  const copy = useAction(async () => {
    if (!candidate) return
    await navigator.clipboard.writeText(JSON.stringify({ version: batch.baseVersion + 1, archiveUri: batch.pack.archiveUri,
      experience: candidate.after, batchId: batch.id }, null, 2))
    notify(t('copied'))
  })
  const evidence = (ids: string[]) => batch.pack.evidence.filter(item => ids.includes(item.id))
  const supporting = candidate ? evidence(candidate.after.support) : []
  const counterexamples = candidate ? evidence(candidate.after.counterexamples) : []
  const sessionId = batch.status === 'queued' || batch.status === 'running' || (target && !batch.pack.evidence.length) ? undefined : batch.sessionId
  const finding = batch.status === 'no_change' && batch.finding
    ? t(batch.finding === 'keep' ? 'dreaming.auditKeep' : 'dreaming.auditInsufficient')
    : audit ? t(audit.outcome === 'revise' ? 'dreaming.auditRevise' : 'dreaming.auditRemove') : undefined
  const writeStatus = unsafeWrite ? 'blocked' : edit?.status
  const hasWriteResult = writeStatus && writeStatus !== 'staged'
  const result = hasWriteResult ? t(`dreaming.memory.${writeStatus}`) : finding ?? t(`dreaming.${batch.status}`)
  const review = !hasWriteResult && batch.status === 'ready' ? candidate?.review : undefined
  const canWriteBack = canCorrect && edit?.status !== 'verified'
  return <Section title={target ? target.uri.split('/').at(-1)! : t('dreaming.batch', { version: batch.baseVersion })}>
    <details>
      <summary>{result}{review && ` · ${t(`dreaming.${review}`)}`}</summary>
      <p><When at={batch.createdAt} /></p>
      {(canWriteBack || sessionId) && <span className="dt-row-buttons">
        {canWriteBack && <Button size="sm" variant="primary" disabled={automatic.busy || unsafeWrite || candidate.review === 'rejected'}
          onClick={() => { void automatic.run() }}>{t('dreaming.writeMemory')}</Button>}
        {canWriteBack && !target && <Button size="sm" aria-expanded={showEditor} aria-controls={editorId}
          disabled={automatic.busy} onClick={() => setShowEditor(open => !open)}>{t('dreaming.manualMemory')}</Button>}
        {sessionId && <Button size="sm" onClick={() => {
          void openSession(sessionId).catch(error => notify(errorText(error)))
        }}>{t('dreaming.session')}</Button>}
      </span>}
      {batch.pack.archiveUri && <Hint>{batch.pack.archiveUri}</Hint>}
      {target && <>
        <Hint>{target.uri}</Hint>
        <details><summary>{t('dreaming.memoryOriginal')}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{target.content}</p></details>
      </>}
      {batch.status === 'no_change' && <>
        <p>{batch.observation || t('dreaming.auditNoEvidence')}</p>
        {target && batch.pack.evidence.length > 0 && <details><summary>{t('dreaming.evidence')}</summary><EvidenceList items={batch.pack.evidence} /></details>}
      </>}
      {batch.status === 'failed' && <p role="status">{t(batch.error === 'timeout' ? 'dreaming.timeout' : 'dreaming.no_result')}</p>}
      {candidate && <>
        {canCorrect && !showEditor && (memoryIssue ? <p role="status">{t(`dreaming.memoryIssue.${memoryIssue}`)}</p> : match
          ? <p role="status">{checkStatus} {match.detail}</p>
          : edit &&
            <p role="status">{t(`dreaming.memory.${edit.status}`)} {edit.error ?? (edit.status === 'verified' ? edit.uri : '')}</p>)}
        {automatic.busy && <p role="status" className="dt-hint">{t('dreaming.memoryUpdating')}</p>}
        {canCorrect && showEditor && 'candidate' in batch && <MemoryCorrection batch={batch} reload={reload} editorId={editorId} />}
        <KeyValues rows={[
          ...(candidate.before ? [[t('dreaming.before'), candidate.before.action] as [string, string]] : []),
          ...(audit?.outcome === 'revise' ? [[t('dreaming.auditPrevious'), audit.patch.previous] as [string, string]] : []),
          ...(audit?.outcome === 'remove' ? [] : [[t('dreaming.after'), candidate.after.action] as [string, string]]),
          [t('dreaming.reason'), candidate.reason],
          ...(candidate.after.verification ? [[t('dreaming.verification'), candidate.after.verification] as [string, string]] : []),
        ]} />
        {(supporting.length > 0 || counterexamples.length > 0) && <details>
          <summary>{t('dreaming.evidenceDetails')}</summary>
          {supporting.length > 0 && <><h3>{t('dreaming.support')}</h3><EvidenceList items={supporting} /></>}
          {counterexamples.length > 0 && <><h3>{t('dreaming.counterexamples')}</h3><EvidenceList items={counterexamples} /></>}
        </details>}
        {!batch.pack.archiveUri && (batch.status === 'ready' || candidate.memory) && <div className="dt-row-buttons">
          <Button size="sm" disabled={action.busy || candidate.review === 'approved'} onClick={() => { void action.run('approved') }}>{t('dreaming.approve')}</Button>
          <Button size="sm" disabled={action.busy || candidate.review === 'rejected'} onClick={() => { void action.run('rejected') }}>{t('dreaming.reject')}</Button>
          <Button size="sm" disabled={action.busy || candidate.review === 'pending'} onClick={() => { void action.run('pending') }}>{t('dreaming.return')}</Button>
          {batch.status === 'ready' && !target && <Button size="sm" disabled={action.busy || candidate.review !== 'approved'}
            onClick={() => { void action.run('publish') }}>{t('dreaming.publish')}</Button>}
        </div>}
        {batch.status === 'published' && batch.pack.archiveUri && <Button size="sm" disabled={copy.busy}
          onClick={() => { void copy.run() }}>{t('dreaming.copy')}</Button>}
      </>}
    </details>
  </Section>
}

export function DreamingPage() {
  const { call, t, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET dreaming'), [call], 3000)
  const start = useAction(() => call('POST dreaming/batches'), { reload })
  const scan = useAction(() => call('POST dreaming/duplicates/scan'), { reload })
  const copy = useAction(async (snapshot: NonNullable<DreamingView['published']>) => {
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
    notify(t('copied'))
  })
  if (!data) return error ? <p className="dt-error" role="alert">{error.message}</p> : <Hint>{t('loading')}</Hint>
  const { canStart, batches, published, openViking, bulk, pack, duplicates, maintenance } = data
  const working = batches.some(batch => batch.status === 'queued' || batch.status === 'running')
  const results = batches.filter(batch => !batch.pack.archiveUri)
  const historical = batches.filter(batch => batch.pack.archiveUri)
  const audited = bulk?.archiveTotal !== undefined
  return <>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    <Section title={t(openViking ? 'dreaming.auditTitle' : 'dreaming.evidence')} action={(openViking || pack) && <Button variant="primary" size="sm"
      disabled={!canStart || working || maintenance?.active || start.busy || scan.busy} onClick={() => { void start.run() }}>
      {t(openViking ? 'dreaming.startAll' : 'dreaming.start')}</Button>}>
      {openViking && <Hint>{t('dreaming.startAllHint')}</Hint>}
      {maintenance && <>
        <Hint>{maintenance.active ? t('dreaming.maintenanceActive') :
          t('dreaming.maintenanceNext', { when: new Date(maintenance.nextAt!).toLocaleString(undefined, { timeZone: 'Asia/Shanghai' }) })}</Hint>
        <Hint>{t('dreaming.maintenanceSummary', maintenance)}</Hint>
      </>}
      {start.busy && <Hint>{t('dreaming.preparingArchives')}</Hint>}
      {bulk && (audited || !openViking) && <>
        <Hint>{t(audited ? 'dreaming.auditSummary' : 'dreaming.bulkSummary', {
          total: bulk.total, queued: bulk.queued, existing: bulk.existing, skipped: bulk.skipped.length, archives: bulk.archiveTotal ?? 0 })}</Hint>
        {bulk.skipped.length > 0 && <details><summary>{t(audited ? 'dreaming.skippedMemories' : 'dreaming.skippedArchives')}</summary>
          <ul>{bulk.skipped.map(uri => <li key={uri}>{uri}</li>)}</ul></details>}
        {!!bulk.archiveSkipped?.length && <details><summary>{t('dreaming.skippedArchives')}</summary>
          <ul>{bulk.archiveSkipped.map(uri => <li key={uri}>{uri}</li>)}</ul></details>}
        {bulk.unavailable.length > 0 && <details><summary>{t('dreaming.unavailableSources')}</summary>
          <ul>{bulk.unavailable.map(uri => <li key={uri}>{uri}</li>)}</ul></details>}
      </>}
      {pack ? <>
        {!canStart && <Hint>{t('dreaming.setup')}</Hint>}
        <KeyValues rows={[[t('dreaming.project'), pack.project]]} />
        <EvidenceList items={pack.evidence} />
      </> : !openViking && <Hint>{t('dreaming.noEvidence')}</Hint>}
    </Section>
    {openViking && <Section title={t('dreaming.duplicateTitle')} action={<Button size="sm" disabled={!canStart || maintenance?.active || scan.busy || start.busy}
      onClick={() => { void scan.run() }}>{t('dreaming.duplicateScan')}</Button>}>
      {scan.busy ? <Hint>{t('dreaming.duplicateScanning')}</Hint> : duplicates && <Hint>{t('dreaming.duplicateCoverage', {
        total: duplicates.total, skipped: duplicates.skipped.length, unavailable: duplicates.unavailable.length })}</Hint>}
      {duplicates && (duplicates.pairs.length ? <ul className="dt-list">{duplicates.pairs.map(pair =>
        <DuplicateReview key={pair.id} pair={pair} reload={reload} />)}</ul> : <Hint>{t('dreaming.duplicateEmpty')}</Hint>)}
    </Section>}
    {results.length > 0 && <details>
      <summary>{t('dreaming.auditResults', { count: results.length })}</summary>
      {results.map(batch => <BatchReview key={batch.id} batch={batch} reload={reload} openViking={openViking} />)}
    </details>}
    {historical.length > 0 && <details><summary>{t('dreaming.archiveHistory')}</summary>
      {historical.map(batch => <BatchReview key={batch.id} batch={batch} reload={reload} openViking={openViking} />)}
    </details>}
    {published && <Section title={t('dreaming.snapshot', { version: published.version })}
      action={<Button size="sm" disabled={copy.busy} onClick={() => { void copy.run(published) }}>{t('dreaming.copy')}</Button>}>
      <KeyValues rows={[[t('dreaming.project'), published.experience.scope], [published.experience.title, published.experience.action]]} />
    </Section>}
  </>
}
