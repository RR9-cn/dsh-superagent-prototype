/** Desktop pilot configuration and independent DingTalk subscription controls. */
import type { StateView } from './api.ts'
import { Button, Input, Switch } from './controls.tsx'
import type { DeploymentForm } from './deployment.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Field, Fields } from './settings-kit.tsx'
import { Hint, KeyValues, Section } from './widgets.tsx'

const DEFAULTS = {
  hiFoxEnabled: false,
  hiFoxSpace: '',
  dingTalkProfile: '',
  dingTalkRepliesEnabled: false,
  hiFoxCli: 'hifox',
  dingTalkCli: 'dws',
}
type HiFoxConfigFields = typeof DEFAULTS
type ConfigKey = keyof HiFoxConfigFields
type KeysOf<V> = { [K in ConfigKey]: HiFoxConfigFields[K] extends V ? K : never }[ConfigKey]
type ConfigOp = Parameters<NonNullable<DeploymentForm>['mutate']>[0][number]
const keys = Object.keys(DEFAULTS) as ConfigKey[]
const fieldsOf = (value: Record<string, unknown>): HiFoxConfigFields => Object.fromEntries(keys.map(key => {
  const saved = value[key]
  return [key, typeof saved === typeof DEFAULTS[key] ? saved : DEFAULTS[key]]
})) as HiFoxConfigFields

export function HiFoxSettings({ form }: { form: DeploymentForm }) {
  const { t, navigate, notify } = usePanel()
  const { state } = usePanelData()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  const draft = useDraft({
    saved: fieldsOf({ ...snapshot?.value, ...state?.setup.machine.hiFoxSettings }),
    revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops = keys.flatMap<ConfigOp>(key => {
        const input = value[key]
        const field = typeof input === 'string' ? input.trim() : input
        return field === base[key] ? [] : field === '' ? [{ op: 'unset', path: [key] }]
          : [{ op: 'set', path: [key], value: field }]
      })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('savedRestarting'))
      return { revision: revision + 1, restarting: true }
    },
  })
  const field = (key: KeysOf<string>, required = false) => <Field key={key} label={t(`hifoxConfig.${key}`)}>
    <Input value={draft.value[key]} required={required && draft.value.hiFoxEnabled}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const toggle = (key: KeysOf<boolean>, hint: string) => <div className="dt-switch-row">
    <div><div className="dt-field-head">{t(`hifoxConfig.${key}`)}</div><small>{hint}</small></div>
    <Switch checked={draft.value[key]} label={t(`hifoxConfig.${key}`)}
      onChange={value => draft.edit({ ...draft.value, [key]: value })} />
  </div>
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Hint>{t('hifoxConfigIntro')}</Hint>
    {!editable && <Hint>{t(!form ? 'deploymentNoForms' : snapshot?.status === 'unavailable'
      ? 'deploymentUnavailable' : 'deploymentReadOnly')}</Hint>}
    <Fields disabled={!editable || draft.busy}>
      <Section title={t('settingsGroup.hifox')}>
        {toggle('hiFoxEnabled', t('hifoxEnableHint'))}
        {field('hiFoxSpace')}
      </Section>
      <Section title={t('hifoxDingTalk')}>
        {field('dingTalkProfile', true)}
        <Hint>{t('hifoxDingTalkScope')}</Hint>
        {toggle('dingTalkRepliesEnabled', t('hifoxRepliesHint'))}
      </Section>
      <details className="dt-details">
        <summary>{t('hifoxCliPaths')}</summary>
        {field('hiFoxCli')}
        {field('dingTalkCli')}
      </details>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
    <Section title={t('hifoxDingTalk')}>
      <div className="dt-row-buttons">
        <Button onClick={() => navigate({ page: 'overview' })}>{t('tab.overview')}</Button>
      </div>
      <DingTalkListener listener={state?.hifox.listener} configured={state?.hifox.state === 'configured'} />
    </Section>
  </form>
}

type Listener = StateView['hifox']['listener']
function DingTalkListener({ listener, configured }: { listener?: Listener; configured: boolean }) {
  const { call, t } = usePanel()
  const { reload, error } = usePanelData()
  const action = useAction(async (start: boolean) => {
    const result = start ? await call('POST hifox/listener/start') : await call('POST hifox/listener/stop')
    if (result.state === 'error' || result.state === 'unavailable') {
      throw new Error(result.detail ?? t(`hifoxListener.${result.state}`))
    }
  }, { reload })
  const status = listener?.state ?? 'unavailable'
  const canStart = configured && (status === 'stopped' || status === 'error')
  const canStop = status === 'listening' || status === 'starting'
  return <div>
    <KeyValues rows={[[t('hifoxListener'), t(`hifoxListener.${status}`)]]} />
    {listener?.detail && <Hint>{listener.detail}</Hint>}
    {(canStart || canStop) && <div className="dt-row-buttons">
      <Button variant="outline" disabled={action.busy || !!error} onClick={() => { void action.run(canStart) }}>
        {t(canStart ? 'hifoxListenerStart' : 'hifoxListenerStop')}
      </Button>
    </div>}
  </div>
}

export function HiFoxOverview() {
  const { navigate, t } = usePanel()
  const { state } = usePanelData()
  const hifox = state?.hifox
  return <Section title={t('settingsGroup.hifox')} action={<Button size="sm" onClick={() => navigate(settingsRoute('hifox'))}>
    {t('hifoxOpenSettings')}
  </Button>}>
    {!hifox || hifox.state === 'unconfigured' ? <Hint>{t('hifoxUnconfigured')}</Hint> : <KeyValues rows={[
      [t('hifoxState'), t(hifox.state === 'paused' ? 'hifoxPaused' : 'hifoxConfigured')],
      [t('hifoxIngress'), t(`hifoxIngress.${hifox.ingress}`)],
      [t('hifoxSpace'), <span className="dt-mono">{hifox.space}</span>],
    ]} />}
    <DingTalkListener listener={hifox?.listener} configured={hifox?.state === 'configured'} />
  </Section>
}
