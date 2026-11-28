import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint, Section } from './widgets.tsx'

export function DreamingPage() {
  const { call, t } = usePanel()
  const { data, error } = usePoll(() => call('GET dreaming'), [call], 3000)
  if (!data) return error ? <p className="dt-error" role="alert">{error.message}</p> : <Hint>{t('loading')}</Hint>
  const { maintenance } = data
  const date = maintenance?.finishedAt && new Date(maintenance.finishedAt).toLocaleDateString(undefined, { timeZone: 'Asia/Shanghai' })
  return <Section title={t('dreaming.dailyResults')}>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {maintenance?.active && <Hint>{t('dreaming.maintenanceActive')}</Hint>}
    {date && maintenance ? <>
      <Hint>{t('dreaming.maintenanceDate', { date })}</Hint>
      <p>{maintenance.merged === undefined
        ? t('dreaming.maintenanceSummary', { revised: maintenance.revised, removed: maintenance.removed })
        : t('dreaming.maintenanceSummaryWithMerges', { revised: maintenance.revised, removed: maintenance.removed, merged: maintenance.merged })}</p>
    </> : !maintenance?.active && <Hint>{t('dreaming.maintenanceEmpty')}</Hint>}
  </Section>
}
