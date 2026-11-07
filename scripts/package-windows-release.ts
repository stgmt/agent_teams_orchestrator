import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync, type Zippable } from 'fflate'

type Options = {
  distDirectory: string
  releaseDirectory: string
  runtimeVersion: string
  sourceCommit: string
  sourceRepository: string
  sourceRef: string
}
const zipTime = new Date(1980, 0, 1)

/** Package only the Windows x64 Claude runtime; never imply other platforms or V2 support exist. */
export function packageWindowsRelease(options: Options) {
  const { distDirectory, releaseDirectory, runtimeVersion, sourceCommit, sourceRepository, sourceRef } = options
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtimeVersion) ||
      !/^[a-f0-9]{40}$/.test(sourceCommit) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository) || !sourceRef.trim()) {
    throw new Error('Windows runtime release identity is invalid')
  }
  if (readFileSync(path.join(distDirectory, 'VERSION'), 'utf8').trim() !== runtimeVersion ||
      readFileSync(path.join(distDirectory, 'COMMIT_SHA'), 'utf8').trim() !== sourceCommit) {
    throw new Error('Windows runtime build identity mismatch')
  }
  if (readFileSync(path.join(distDirectory, 'WINDOWS_CLAUDE_DELIVERY'), 'utf8').trim() !== 'off') {
    throw new Error('Windows Claude-only build evidence missing')
  }
  const files: Zippable = {}
  function addFile(diskPath: string, archivePath: string) {
    const stat = lstatSync(diskPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime file must be regular: ${archivePath}`)
    const bytes = readFileSync(diskPath)
    if (!bytes.length && archivePath === 'runtime/claude-multimodel.exe') throw new Error('Runtime executable is empty')
    files[archivePath] = [bytes, { mtime: zipTime }]
  }
  function addDirectory(diskPath: string, archivePath: string) {
    const stat = lstatSync(diskPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Runtime directory must be regular: ${archivePath}`)
    for (const name of readdirSync(diskPath).sort()) {
      const child = path.join(diskPath, name)
      if (lstatSync(child).isDirectory()) addDirectory(child, `${archivePath}/${name}`)
      else addFile(child, `${archivePath}/${name}`)
    }
  }
  addFile(path.join(distDirectory, 'cli.exe'), 'runtime/claude-multimodel.exe')
  addFile(path.join(distDirectory, 'COMMIT_SHA'), 'runtime/COMMIT_SHA')
  addFile(path.join(distDirectory, 'VERSION'), 'runtime/VERSION')
  addDirectory(path.join(distDirectory, 'cursor-managed'), 'runtime/cursor-managed')
  if (!Object.keys(files).some(name => name.startsWith('runtime/cursor-managed/'))) {
    throw new Error('Managed Cursor assets are empty')
  }
  const file = `agent-teams-runtime-win32-x64-v${runtimeVersion}.zip`
  const manifestFile = `agent-teams-runtime-manifest-v${runtimeVersion}.json`
  const checksumsFile = `agent-teams-runtime-SHA256SUMS-v${runtimeVersion}`
  const archive = zipSync(files, { level: 9, mtime: zipTime })
  const digest = createHash('sha256').update(archive).digest('hex')
  const manifest = {
    schemaVersion: 1,
    releaseKind: 'windows-x64-claude-only',
    version: runtimeVersion,
    targetReleaseTag: `runtime-v${runtimeVersion}`,
    sourceRepository,
    sourceRef,
    sourceCommit,
    opencodeV2Delivery: 'off',
    assets: { 'win32-x64': { file, archiveKind: 'zip', binaryName: 'claude-multimodel.exe', sha256: digest } },
  }
  mkdirSync(releaseDirectory, { recursive: true })
  writeFileSync(path.join(releaseDirectory, file), archive)
  writeFileSync(path.join(releaseDirectory, manifestFile), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(path.join(releaseDirectory, checksumsFile), `${digest}  ${file}\n`)
  return { manifest, publicAssets: [file, manifestFile, checksumsFile] }
}

if (import.meta.main) {
  const { RUNTIME_VERSION, RUNTIME_SOURCE_COMMIT, GITHUB_REPOSITORY, GITHUB_REF } = process.env
  if (!RUNTIME_VERSION || !RUNTIME_SOURCE_COMMIT || !GITHUB_REPOSITORY || !GITHUB_REF) {
    throw new Error('Windows runtime release environment is incomplete')
  }
  const metadata: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== RUNTIME_VERSION) {
    throw new Error('Runtime package version mismatch')
  }
  packageWindowsRelease({ distDirectory: 'dist', releaseDirectory: 'release-flat', runtimeVersion: RUNTIME_VERSION,
    sourceCommit: RUNTIME_SOURCE_COMMIT, sourceRepository: GITHUB_REPOSITORY, sourceRef: GITHUB_REF })
}
