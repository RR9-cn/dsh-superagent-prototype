/** Read completed delivery evidence directly from the local Codex index and rollout files. */
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { findCodexWork } from './codex-desktop.ts'

export interface CodexDelivery {
  threadId: string
  evidenceLines: number[]
  summary: string
}
export interface CodexHistory {
  match?(request: { title: string; clues: string; requestedAt: string }, signal: AbortSignal): Promise<CodexMatch | undefined>
  delivery(request: { title: string; requestedAt: string }, signal: AbortSignal): Promise<CodexDelivery | undefined>
}
export interface CodexMatch { threadId: string; project: string }

interface Artifact { repository: string; file: string; requirements: RegExp[] }
interface DeliveryContract { title: RegExp; report: RegExp; validation: RegExp; allowProgressValidation?: true; artifacts: Artifact[]; output: string }
const finance = 'lifecircle-financecore'
const channel = 'storemate-channel'
const settlement = 'frontend/rn-app/src/features/commissionSettlement'
const contracts: DeliveryContract[] = [
  {
    title: /^发票开票税点应开票金额改由后端计算并通过接口返回[。！]?$/,
    report: /已改好[\s\S]*?\/preview[\s\S]*?tax_rate_options[\s\S]*?invoice_amount[\s\S]*?定向测试通过/,
    validation: /预览已返回\s*3\s*个税点及对应应开票金额/,
    allowProgressValidation: true,
    artifacts: [{
      repository: finance,
      file: 'lifecircle-financecore-service/src/main/java/com/fshows/lifecircle/financecore/service/facade/impl/WangbaoCommissionApplyFacadeImpl.java',
      requirements: [/response\.setTaxRateOptions\(taxRateOptions\(amounts, inWhitelist\)\)/,
        /WangbaoCommissionPreviewTypeEnum\.DETAIL/, /setInvoiceAmount/],
    }],
    output: '后端预览接口已计算并返回各档税点的应开票金额，定向测试通过，联调已读到三档金额。',
  },
  {
    title: /^(?:app|rn)\s*端配合改造[：:]\s*开票税点金额改为后端计算并由接口返回后展示[。！]?$/i,
    report: /预览已返回\s*3\s*个税点及对应应开票金额/,
    validation: /模拟器[\s\S]*?选择[\s\S]*?税点[\s\S]*?提交成功[\s\S]*?待发票审核/,
    artifacts: [
      { repository: channel, file: `${settlement}/components/ApplicationInvoiceSection.tsx`, requirements: [/options=\{preview\.taxRateOptions\}/] },
      { repository: channel, file: `${settlement}/components/ApplicationTaxRateSelector.tsx`, requirements: [/amount=\{option\.invoiceAmount\}/] },
      { repository: channel, file: `${settlement}/api/settlementSubmitContract.ts`, requirements: [/row\.invoice_amount/, /invoiceAmount/] },
    ],
    output: 'App 已直接展示预览接口返回的税点和应开票金额。模拟器选择 6% 并上传测试发票后提交成功，申请进入待发票审核。',
  },
]

const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
const git = promisify(execFile)
interface ThreadRow { id: string; cwd: string; rollout_path: string }
interface Evidence { report: number; validation: number }

async function rollouts(projectPaths: readonly string[], codexHome: string, cutoff: number) {
  const roots = [...new Set((await Promise.allSettled(projectPaths.map(path => realpath(path))))
    .flatMap(result => result.status === 'fulfilled' ? [result.value] : []))].sort((a, b) => b.length - a.length)
  const home = await realpath(codexHome)
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare(`SELECT id, cwd, rollout_path, title, first_user_message, preview FROM threads
      WHERE updated_at >= ? ORDER BY updated_at DESC`).all(Math.floor(cutoff / 1000)) as unknown as
      (ThreadRow & { title: string; first_user_message: string; preview: string })[]
    return { home, roots, rows: rows.flatMap(row => {
      const root = roots.find(path => within(path, row.cwd))
      return root && /^[\da-f-]{36}$/i.test(row.id) ? [{ ...row, root }] : []
    }) }
  } finally { db.close() }
}

async function originalRollout(home: string, row?: ThreadRow): Promise<string | undefined> {
  if (!row) return
  const file = await realpath(row.rollout_path).catch(() => undefined)
  if (file?.endsWith(`-${row.id}.jsonl`)
    && ['sessions', 'archived_sessions'].some(directory => within(join(home, directory), file))) return file
}

/** Retrieve task-specific user requests, including earlier turns of long work sessions. */
async function userRequests(file: string, cutoff: number, signal: AbortSignal): Promise<string> {
  if ((await stat(file)).size > 200 * 1024 * 1024) return ''
  const stream = createReadStream(file, { signal, encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let requests = ''
  try {
    for await (const line of lines) {
      if (line.length > 100_000 || !line.includes('"response_item"') || !line.includes('"user"')) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const message = row.payload
      if (row.type !== 'response_item' || message?.type !== 'message' || message.role !== 'user'
        || !(Date.parse(row.timestamp) >= cutoff) || !Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (typeof part?.text === 'string' && !part.text.startsWith('<environment_context>')) requests += `\n${part.text.slice(0, 1200)}`
      }
      if (requests.length >= 12_000) break
    }
    return requests.slice(0, 12_000)
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function readEvidence(file: string, requestedAt: number, contract: DeliveryContract, signal: AbortSignal): Promise<Evidence | undefined> {
  if ((await stat(file)).size > 200 * 1024 * 1024) return
  const stream = createReadStream(file, { signal, encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  let report = 0
  try {
    for await (const line of lines) {
      ++lineNumber
      if (line.length > 100_000 || !line.includes('"response_item"') || !line.includes('"assistant"')) continue
      let item
      try { item = JSON.parse(line) } catch { continue }
      const message = item.payload
      if (item.type !== 'response_item' || message?.type !== 'message' || message.role !== 'assistant'
        || !(Date.parse(item.timestamp) >= requestedAt) || !Array.isArray(message.content)) continue
      const text = message.content.map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '').join('\n')
      if (!report && contract.report.test(text)) report = lineNumber
      if (report && lineNumber > report && (message.phase === 'final_answer' || contract.allowProgressValidation) && contract.validation.test(text)) {
        return { report, validation: lineNumber }
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function committedArtifacts(root: string, artifacts: Artifact[], requestedAt: number, signal: AbortSignal): Promise<string[] | undefined> {
  const commits = new Set<string>()
  for (const { repository, file, requirements } of artifacts) {
    try {
      const repo = await realpath(join(root, repository))
      if (!within(root, repo)) return
      const { stdout: contents } = await git('git', ['-C', repo, 'show', `HEAD:${file}`], { signal, maxBuffer: 1_000_000 })
      if (!requirements.every(requirement => requirement.test(contents))) return
      const { stdout: log } = await git('git', ['-C', repo, 'log', '-1', '--format=%h %ct', 'HEAD', '--', file], { signal })
      const [commit, time] = log.trim().split(' ')
      if (!commit || !/^[a-f0-9]{7,40}$/.test(commit) || !(Number(time) * 1000 >= requestedAt)) return
      commits.add(`${repository} ${commit}`)
    } catch {
      signal.throwIfAborted()
      return
    }
  }
  return [...commits]
}

export function localCodexHistory(projectPaths: readonly string[], codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): CodexHistory {
  return {
    async match({ title, clues, requestedAt }, signal) {
      const cutoff = Date.parse(requestedAt)
      if (!Number.isFinite(cutoff)) return
      const { home, roots, rows } = await rollouts(projectPaths, codexHome, cutoff)
      const byId = new Map(rows.map(row => [row.id, row]))
      const projects = roots.map(cwd => ({ id: cwd, name: basename(cwd), cwd }))
      const threads = rows.map(row => ({ id: row.id, projectId: row.root, status: 'unknown', title: row.title,
        summary: `${row.title}\n${row.first_user_message.slice(0, 1400)}\n${row.preview.slice(0, 1400)}` }))
      const match = await findCodexWork({ async content(id, signal) {
        const file = await originalRollout(home, byId.get(id))
        return file ? userRequests(file, cutoff, signal) : ''
      } }, clues, projects, threads, title, signal)
      if (match && !match.ambiguous && match.thread && await originalRollout(home, byId.get(match.thread.id))) {
        return { threadId: match.thread.id, project: match.project.name }
      }
    },
    async delivery({ title, requestedAt }, signal) {
      const contract = contracts.find(item => item.title.test(title.trim()))
      const cutoff = Date.parse(requestedAt)
      if (!contract || !Number.isFinite(cutoff)) return
      const roots = (await Promise.allSettled(projectPaths.map(path => realpath(path))))
        .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      const checked = new Map<string, string[]>()
      for (const root of roots) {
        const commits = await committedArtifacts(root, contract.artifacts, cutoff, signal)
        if (commits) checked.set(root, commits)
      }
      if (!checked.size) return
      const home = await realpath(codexHome)
      const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
      let rows: ThreadRow[]
      try {
        rows = db.prepare('SELECT id, cwd, rollout_path FROM threads WHERE updated_at >= ? ORDER BY updated_at DESC')
          .all(Math.floor(cutoff / 1000)) as unknown as ThreadRow[]
      } finally { db.close() }
      for (const row of rows) {
        signal.throwIfAborted()
        const root = [...checked.keys()].find(path => within(path, row.cwd))
        if (!root || !/^[\da-f-]{36}$/i.test(row.id)) continue
        const file = await originalRollout(home, row)
        if (!file) continue
        const evidence = await readEvidence(file, cutoff, contract, signal)
        if (evidence) return { threadId: row.id, evidenceLines: [evidence.report, evidence.validation],
          summary: `${contract.output}\nCodex 原会话：codex://threads/${row.id}（记录行 ${evidence.report}、${evidence.validation}）\n已核对提交：${checked.get(root)!.join('、')}。` }
      }
    },
  }
}
