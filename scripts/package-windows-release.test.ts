import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { packageWindowsRelease } from './package-windows-release.js'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-release-'))
  const distDirectory = path.join(root, 'dist')
  await mkdir(path.join(distDirectory, 'cursor-managed'), { recursive: true })
  const options = { distDirectory, releaseDirectory: path.join(root, 'release'), runtimeVersion: '0.0.999',
    sourceCommit: 'a'.repeat(40), sourceRepository: 'owner/runtime', sourceRef: 'refs/heads/release' }
  await writeFile(path.join(distDirectory, 'VERSION'), options.runtimeVersion + '\n')
  await writeFile(path.join(distDirectory, 'COMMIT_SHA'), options.sourceCommit + '\n')
  await writeFile(path.join(distDirectory, 'WINDOWS_CLAUDE_DELIVERY'), 'off\n')
  await writeFile(path.join(distDirectory, 'cli.exe'), 'executable')
  await writeFile(path.join(distDirectory, 'cursor-managed', 'asset'), 'asset')
  return { root, options }
}

test('one-platform archive binds exact source, version, bytes and excludes OpenCode', async () => {
  const { root, options } = await fixture()
  try {
    const { manifest, publicAssets } = packageWindowsRelease(options)
    expect(Object.keys(manifest.assets)).toEqual(['win32-x64'])
    expect(manifest.releaseKind).toBe('windows-x64-claude-only')
    expect(manifest.opencodeV2Delivery).toBe('off')
    expect(manifest.sourceCommit).toBe(options.sourceCommit)
    expect(manifest.version).toBe(options.runtimeVersion)
    const asset = manifest.assets['win32-x64']
    const bytes = await readFile(path.join(options.releaseDirectory, asset.file))
    expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const entries = unzipSync(bytes)
    expect(new TextDecoder().decode(entries['runtime/COMMIT_SHA']!)).toBe(options.sourceCommit + '\n')
    expect(new TextDecoder().decode(entries['runtime/VERSION']!)).toBe(options.runtimeVersion + '\n')
    expect(Object.keys(entries).sort()).toEqual(['runtime/COMMIT_SHA', 'runtime/VERSION', 'runtime/claude-multimodel.exe', 'runtime/cursor-managed/asset'])
    expect(publicAssets).toHaveLength(3)
    const sums = await readFile(path.join(options.releaseDirectory, publicAssets[2]!), 'utf8')
    expect(sums).toBe(`${asset.sha256}  ${asset.file}\n`)
    packageWindowsRelease(options)
    expect(await readFile(path.join(options.releaseDirectory, asset.file))).toEqual(bytes)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects incorrect source, version, delivery mode and missing binary', async () => {
  const { root, options } = await fixture()
  try {
    expect(() => packageWindowsRelease({ ...options, sourceCommit: 'b'.repeat(40) })).toThrow('identity mismatch')
    expect(() => packageWindowsRelease({ ...options, runtimeVersion: '0.0.998' })).toThrow('identity mismatch')
    expect(() => packageWindowsRelease({ ...options, sourceCommit: 'bad' })).toThrow('identity is invalid')
    await writeFile(path.join(options.distDirectory, 'WINDOWS_CLAUDE_DELIVERY'), 'bundled')
    expect(() => packageWindowsRelease(options)).toThrow('Claude-only build evidence')
    await writeFile(path.join(options.distDirectory, 'WINDOWS_CLAUDE_DELIVERY'), 'off')
    await rm(path.join(options.distDirectory, 'cli.exe'))
    expect(() => packageWindowsRelease(options)).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
