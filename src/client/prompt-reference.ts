/** Read-only Chinese references for exact matches to the packaged prompt sources. */
import shared from '../../prompts/shared.md?raw'
import orchestrator from '../../prompts/orchestrator.md?raw'
import worker from '../../prompts/worker.md?raw'
import subscriptions from '../../prompts/subscriptions.md?raw'
import replies from '../../prompts/replies.md?raw'
import dispatch from '../../prompts/dispatch.md?raw'
import work from '../../prompts/work.md?raw'
import admission from '../../prompts/admission.md?raw'
import handoff from '../../prompts/handoff.md?raw'
import orchestratorHandoff from '../../prompts/handoff-orchestrator.md?raw'
import workerHandoff from '../../prompts/handoff-worker.md?raw'
import communication from '../../prompts/team/communication.md?raw'
import scope from '../../prompts/team/scope.md?raw'
import delivery from '../../prompts/team/delivery.md?raw'
import translations from './prompt-reference.zh.md?raw'

const normalize = (text: string): string => text.trim().split(/\r?\n(?:[ \t]*\r?\n)+/)
  .map(paragraph => paragraph.split(/\r?\n/).map(line => line.trim()).join(' ')).join('\n')

const environment = "Execution environment (from this installation's settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:\n{variables}"
const policyHead = '## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.'
const pendingEnvironment = 'Execution environment: dsh-superagent is waiting for setup; the management panel names what is missing.'

const originals: Record<string, string> = {
  'runtime/shared': normalize(shared),
  'runtime/orchestrator': normalize(orchestrator),
  'runtime/worker': normalize(worker),
  'runtime/subscriptions': `## subscriptions\n${normalize(subscriptions)}`,
  'runtime/replies': `## replies\n${normalize(replies)}`,
  'runtime/dispatch': `## dispatch\n${normalize(dispatch)}`,
  'runtime/work': `## work\n${normalize(work)}`,
  'runtime/admission': normalize(admission),
  'runtime/handoff/orchestrator': `${normalize(handoff)}\n${normalize(orchestratorHandoff)}`,
  'runtime/handoff/worker': `${normalize(handoff)}\n${normalize(workerHandoff)}`,
  'runtime/environment': environment,
  'runtime/policy': `${policyHead} The enabled rules, by name and id:\n{rules}`,
  'runtime/policy/none': `${policyHead} No rule is enabled: a proactive candidate can only be ignored.`,
  communication: normalize(communication),
  scope: normalize(scope),
  delivery: normalize(delivery),
}
const chinese = new Map<string, string>()
const sections = translations.split(/^<!-- ([\w/]+) -->$/m)
for (let index = 1; index < sections.length; index += 2) {
  chinese.set(sections[index]!, sections[index + 1]!.trim())
}

const tokens = /\{(\w+)\}/g
const templateKeys = new Set(['runtime/environment', 'runtime/policy', 'runtime/policy/none'])
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function chinesePrompt(key: string, text: string, composed = false): string | undefined {
  const source = Object.hasOwn(originals, key) ? originals[key] : undefined
  const reference = chinese.get(key)
  if (!source || !reference) return undefined
  if (text === source) return reference
  if (!composed || !templateKeys.has(key)) return undefined
  if (key === 'runtime/environment' && text === pendingEnvironment) {
    return '执行环境：dsh-superagent 正在等待完成设置。管理面板会显示待配置项。'
  }
  const pattern = source.split(tokens).map((piece, index) => index % 2 ? `(?<${piece}>[\\s\\S]*?)` : escapePattern(piece)).join('')
  const values = new RegExp(`^${pattern}$`).exec(text)?.groups
  return values ? reference.replace(tokens, (_token, name: string) => values[name] ?? '') : undefined
}
