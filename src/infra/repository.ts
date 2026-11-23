import type { Commands } from './commands.ts'

/** Read committed objects from the configured local Git worktree without following working-tree symlinks. */
export async function readRepositoryPath(commands: Pick<Commands, 'git'>, repositoryPath: string | undefined,
  path: string, kind: 'file' | 'directory'): Promise<string> {
  if (!repositoryPath) throw new Error('This installation has no local repository configured for assessments')
  const parts = path.split('/').filter(part => part && part !== '.')
  if (path.startsWith('/') || parts.some(part => part.startsWith('.') || part === 'node_modules' || /[\x00-\x1f\x7f]/.test(part))) {
    throw new Error('Only non-hidden repository source paths are available')
  }
  if (kind === 'file' && !parts.length) throw new Error('A repository file path is required')
  const noFetch = { GIT_NO_LAZY_FETCH: '1' }
  const object = parts.length ? `HEAD:${parts.join('/')}` : 'HEAD'
  if (kind === 'file') return commands.git(['--no-replace-objects', 'cat-file', 'blob', object], repositoryPath, noFetch)
  const entries = await commands.git(['--no-replace-objects', 'ls-tree', '--full-tree', '-z', '--name-only', object], repositoryPath, noFetch)
  return entries.split('\0').filter(name => name && !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
