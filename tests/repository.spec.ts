import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { readRepositoryPath } from '../src/infra/repository.ts'
import { gitEnv } from './fixtures/git.ts'
import { testDeployment } from './fixtures/deployment.ts'

it('reads committed local Git context without consulting a remote or opening working-tree files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-repository-'))
  try {
    const env = gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
    git('init', '--quiet')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'value.txt'), 'committed')
    writeFileSync(join(dir, '.private'), 'hidden')
    symlinkSync('/outside', join(dir, 'link'))
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
    writeFileSync(join(dir, 'src', 'value.txt'), 'unsaved')
    const commands = new Commands(() => testDeployment(), env, new AbortController().signal)
    await expect(readRepositoryPath(commands, dir, '', 'directory')).resolves.toBe('link\nsrc')
    await expect(readRepositoryPath(commands, dir, 'src', 'directory')).resolves.toBe('value.txt')
    await expect(readRepositoryPath(commands, dir, 'src/value.txt', 'file')).resolves.toBe('committed')
    await expect(readRepositoryPath(commands, dir, 'link', 'file')).resolves.toBe('/outside')
    await expect(readRepositoryPath(commands, dir, '.private', 'file')).rejects.toThrow('Only non-hidden')
    await expect(readRepositoryPath(commands, dir, 'src/../.private', 'file')).rejects.toThrow('Only non-hidden')
    await expect(readRepositoryPath(commands, undefined, 'src/value.txt', 'file')).rejects.toThrow('no local repository')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
