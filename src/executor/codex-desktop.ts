import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { z } from 'zod'

export interface CodexProject { id: string; name: string; cwd: string }
export interface CodexThread { id: string; projectId: string; title: string; status: string; summary?: string }
export interface CodexDesktop {
  projects(signal: AbortSignal): Promise<CodexProject[]>
  threads(signal: AbortSignal): Promise<CodexThread[]>
  content?(id: string, signal: AbortSignal): Promise<string>
  create(project: CodexProject, title: string, prompt: string, signal: AbortSignal): Promise<string>
  status(id: string, signal: AbortSignal): Promise<string>
}

const project = z.object({ projectId: z.string().min(1), label: z.string(), path: z.string().refine(isAbsolute),
  projectKind: z.literal('local'), hostId: z.literal('local') })
const thread = z.object({ id: z.string().uuid(), projectId: z.string().min(1), title: z.string(), status: z.string(),
  summary: z.string().nullish().transform(value => value?.slice(0, 3000)),
  kind: z.literal('codex'), hostId: z.literal('local'), cwd: z.string().refine(isAbsolute) })

/** The installed Codex Bridge desktop-tasks endpoint, using its single-request NDJSON protocol. */
export const codexDesktopSocket = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'native-relay.sock-desktop-tasks')
export function codexDesktop(path: string, projectPaths: readonly string[]): CodexDesktop {
  const allowed = new Set(projectPaths.map(path => resolvePath(path)))
  const request = (operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = createConnection({ path, signal })
      let response = ''
      socket.setEncoding('utf8')
      socket.setTimeout(12_000, () => socket.destroy(new Error('Codex Desktop request timed out')))
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('Codex Desktop closed the request')))
      socket.once('connect', () => socket.write(JSON.stringify({ v: 1, operation, arguments: args }) + '\n'))
      socket.on('data', (chunk: string) => {
        response += chunk
        if (response.length > 2_000_000) return socket.destroy(new Error('Codex Desktop response exceeded the size limit'))
        const end = response.indexOf('\n')
        if (end < 0) return
        try {
          const envelope = z.object({ v: z.literal(1), ok: z.literal(true), operation: z.literal(operation),
            result: z.unknown() }).parse(JSON.parse(response.slice(0, end)))
          resolve(envelope.result)
          socket.destroy()
        } catch {
          socket.destroy(new Error(`Codex Desktop could not confirm ${operation}`))
        }
      })
    })
  return {
    async projects(signal) {
      const result = z.object({ projects: z.array(z.unknown()) }).parse(await request('list_projects', {}, signal))
      return result.projects.flatMap(row => {
        const item = project.safeParse(row).data
        return item && allowed.has(resolvePath(item.path)) ? [{ id: item.projectId, name: item.label || basename(item.path), cwd: item.path }] : []
      })
    },
    async threads(signal) {
      const result = z.object({ threads: z.array(z.unknown()), pinnedThreads: z.array(z.unknown()),
        unavailableHosts: z.array(z.unknown()).optional() }).parse(await request('list_threads', { limit: 50 }, signal))
      if (result.unavailableHosts?.some(host => host === 'local' || (typeof host === 'object' && host && 'hostId' in host && host.hostId === 'local'))) {
        throw new Error('Codex Desktop local tasks are unavailable')
      }
      const threads = new Map<string, CodexThread>()
      for (const row of [...result.pinnedThreads, ...result.threads]) {
        const item = thread.safeParse(row).data
        if (item) threads.set(item.id, item)
      }
      return [...threads.values()]
    },
    async create(project, title, prompt, signal) {
      const current = (await this.projects(signal)).find(item => item.id === project.id && item.cwd === project.cwd)
      if (!current) throw new Error('The Codex project has changed')
      const result = z.object({ threadId: z.string().uuid().optional(), conversationId: z.string().uuid().optional(),
        hostId: z.literal('local'), status: z.string().optional(), firstTurn: z.object({ status: z.string() }).optional(),
      }).parse(await request('create_thread', { title, prompt, target: { type: 'project', projectId: project.id, environment: { type: 'local' } } }, signal))
      const id = result.threadId ?? result.conversationId
      if (!id || result.status === 'outcome-unknown' || (result.firstTurn && result.firstTurn.status !== 'accepted')) {
        throw new Error('Codex Desktop did not confirm the new execution')
      }
      return id
    },
    async status(id, signal) {
      const result = z.object({ thread: z.object({ id: z.literal(id), hostId: z.literal('local'), status: z.object({ type: z.string() }) }) })
        .parse(await request('read_thread', { threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: false }, signal))
      return result.thread.status.type
    },
    async content(id, signal) {
      const itemSchema = z.object({ type: z.literal('userMessage'), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
      const result = z.object({ thread: z.object({ id: z.literal(id), hostId: z.literal('local') }),
        turns: z.array(z.object({ items: z.array(z.unknown()) })) })
        .parse(await request('read_thread', { threadId: id, hostId: 'local', turnLimit: 2, includeOutputs: false }, signal))
      return result.turns.flatMap(turn => turn.items.flatMap(raw => {
        const item = itemSchema.safeParse(raw).data
        return item?.content.filter(part => part.type === 'text').map(part => part.text?.slice(0, 1400) ?? '') ?? []
      })).join('\n').slice(0, 6000)
    },
  }
}

const refs = (value: string) => new Set(value.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])
const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = new Intl.Segmenter('zh', { granularity: 'word' })
const genericWords = new Set(['任务', '项目', '问题', '会话', '已经', '相关', '当前', '实现', '处理', '调整', '修改', '修复', '补充', '更新',
  '执行', '开发', '需要', '继续', '验证', '完成', '支持', '功能', '测试', '代码', '接口', '页面', '工作', '信息', '请问', '开始',
  '注意', '命令', '下载', '资料', '结果', '要求', '查看', '说明', '原因', '确认',
  'codex', 'hifox', 'project', 'task', 'fix', 'change', 'update', 'implement', 'added', 'using', 'the', 'and', 'with', 'for'])
const particles = new Set([...('的了和及而与或在将从用于以为是对把被由也并都就还请需让按再中内外上下一')])

function contentTerms(value: string): Set<string> {
  const segments = [...words.segment(value.normalize('NFKC').toLowerCase())]
  const terms = new Set<string>()
  for (const [index, { segment, isWordLike }] of segments.entries()) {
    if (!isWordLike || genericWords.has(segment)) continue
    if (/^\p{Script=Han}{2,}$/u.test(segment) || /^[a-z][a-z0-9_]{2,}$/.test(segment)) terms.add(segment)
    // ICU can split domain terms such as 税额 and 舍入 into adjacent single characters.
    const next = segments[index + 1]?.segment
    if (next && (segment.length === 1 || next.length === 1) && !particles.has(segment) && !particles.has(next)
      && !genericWords.has(next) && /^\p{Script=Han}{2,5}$/u.test(segment + next)) terms.add(segment + next)
  }
  return terms
}

/** Look for multiple distinctive facts shared by the card and the actual session summary. */
function matchByContent(clues: string, cardContent: string, threads: readonly CodexThread[]) {
  const requested = contentTerms(`${clues}\n${cardContent}`)
  const cardTerms = contentTerms(cardContent)
  const corpus = threads.filter(item => item.summary?.trim()).map(thread => ({ thread, terms: contentTerms(thread.summary!) }))
  const frequency = new Map<string, number>()
  for (const entry of corpus) for (const term of entry.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const ranked = corpus.map(({ thread, terms }) => {
    const overlap = [...requested].filter(term => terms.has(term))
    const shared = overlap.filter(term => !overlap.some(other => other.length > term.length && other.includes(term)))
    const score = shared.reduce((sum, term) => sum + Math.min(term.length, 8) / Math.sqrt(frequency.get(term)!), 0)
    return { thread, shared, score, cardOverlap: shared.filter(term => cardTerms.has(term)).length }
  }).filter(entry => entry.cardOverlap >= 2 && entry.shared.length >= 3 && entry.score >= 7).sort((a, b) => b.score - a.score)
  const [first, second] = ranked
  if (!first) return undefined
  if (second && second.score * 1.5 > first.score) return { ambiguous: true as const }
  return { thread: first.thread, evidence: first.shared.slice(0, 6) }
}

export function matchCodexWork(clues: string, projects: readonly CodexProject[], threads: readonly CodexThread[], cardContent = '') {
  const direct = new Set([...clues.matchAll(/codex:\/\/threads\/([\da-f-]{36})/gi)].map(match => match[1]!.toLowerCase()))
  const clueRefs = refs(clues)
  const normalized = compact(clues)
  const named = projects.filter(project => [project.cwd, project.name, basename(project.cwd)].some(value =>
    value.length >= 3 && new RegExp(`(^|[^a-z0-9_/-])${escape(value)}($|[^a-z0-9_/-])`, 'i').test(clues)))
  const inScope = threads.filter(item => projects.some(project => project.id === item.projectId)
    && (!named.length || named.some(project => project.id === item.projectId)))
  const candidates = inScope.filter(item => {
    if (direct.size) return direct.has(item.id.toLowerCase())
    const title = compact(item.title)
    return [...refs(item.title)].some(ref => clueRefs.has(ref)) || (title.length >= 8 && normalized.includes(title))
  })
  if (direct.size && candidates.length !== 1) return { ambiguous: true as const }
  const content = !candidates.length && matchByContent(clues, cardContent, inScope)
  if (content) {
    if (content.ambiguous) return { ambiguous: true as const }
    return { project: projects.find(project => project.id === content.thread.projectId)!, ...content }
  }
  const projectIds = new Set([...named.map(item => item.id), ...candidates.map(item => item.projectId)])
  if (projectIds.size > 1) return { ambiguous: true as const }
  const selected = projects.find(item => projectIds.has(item.id))
  return selected ? { project: selected, thread: candidates.length === 1 ? candidates[0] : undefined } : undefined
}

export async function findCodexWork(desktop: CodexDesktop, clues: string, projects: readonly CodexProject[],
  threads: readonly CodexThread[], cardContent: string, signal: AbortSignal) {
  const first = matchCodexWork(clues, projects, threads, cardContent)
  if (!desktop.content || (first && !first.ambiguous && first.thread)) return first

  const terms = contentTerms(`${clues}\n${cardContent}`)
  const candidates = threads.filter(thread => projects.some(project => project.id === thread.projectId))
    .map(thread => ({ thread, overlap: [...contentTerms(`${thread.title}\n${thread.summary ?? ''}`)].filter(term => terms.has(term)).length }))
    .sort((a, b) => b.overlap - a.overlap).slice(0, 8)
  const evidence = new Map<string, string>()
  await Promise.allSettled(candidates.map(async ({ thread }) => evidence.set(thread.id, await desktop.content!(thread.id, signal))))
  signal.throwIfAborted()
  const expanded = threads.map(thread => evidence.get(thread.id)
    ? { ...thread, summary: `${thread.summary ?? ''}\n${evidence.get(thread.id)}` } : thread)
  return matchCodexWork(clues, projects, expanded, cardContent)
}
