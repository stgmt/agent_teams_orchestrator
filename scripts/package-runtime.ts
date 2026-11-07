import { openCodeBunVersion } from '../src/constants/openCodeBunVersion.js'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { validatePackagedOpenCodeIdentity } from '../src/cli/packagedOpenCodeDelivery.js'
import { verifyLinuxCustodyArtifact } from './lib/opencode-custody-artifact.js'
import { openCodeV2ReleaseContract } from '../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { packageOpenCodeV2Delivery } from './opencode-v2/delivery.js'
import { openCodeV2ReleaseDelivery } from './opencode-v2/release-delivery.js'

const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(name) + 1]
const platform = option('--platform')
const pins = JSON.parse(await readFile(new URL('./runtime-bun-pins.json', import.meta.url), 'utf8')) as {
  version: '1.3.11'; assets: Record<string, { file: string; sha256: string; entry: string; version?: ReturnType<typeof openCodeBunVersion> }>
}
if (!args.includes('--platform') || !platform || !Object.hasOwn(pins.assets, platform) || pins.version !== '1.3.11') {
  throw new Error('Unsupported runtime release platform')
}
type Asset = { file: string; sha256: string; entry: string; version?: ReturnType<typeof openCodeBunVersion> }
for (const [target, asset] of Object.entries(pins.assets)) {
  if ((asset.version ?? pins.version) !== openCodeBunVersion(target.split('-')[0])) {
    throw new Error('Runtime Bun platform pin mismatch')
  }
}
if (platform.startsWith('linux-')) {
  if (process.platform !== 'linux' || platform !== `linux-${process.arch}`) {
    throw new Error('Native custody delivery requires the matching physical Linux build lane')
  }
  const staged = Bun.spawnSync({ cmd: [process.execPath, './scripts/stage-opencode-custody.mts'], stdout: 'inherit', stderr: 'inherit' })
  if (staged.exitCode !== 0) throw new Error('Native custody artifact staging failed')
  verifyLinuxCustodyArtifact('./dist/native', platform, './native/opencode-custody/linux.c')
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function pinnedBinary(selected: Asset, localArchive?: string): Promise<Uint8Array> {
  const archive = localArchive ? await readFile(path.resolve(localArchive)) :
    new Uint8Array(await (async () => {
      const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${selected.version ?? pins.version}/${selected.file}`, {
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error('Pinned Bun archive download failed')
      return response.arrayBuffer()
    })())
  if (sha(archive) !== selected.sha256) throw new Error('Pinned Bun archive checksum mismatch')
  const binary = unzipSync(archive)[selected.entry]
  if (!binary || binary.length === 0) throw new Error('Pinned Bun archive entry missing')
  return binary
}
async function stageBinary(directory: string, target: string, binary: Uint8Array): Promise<string> {
  await mkdir(directory, { recursive: true })
  const file = path.resolve(directory, target.startsWith('win32-') ? 'bun.exe' : 'bun')
  await writeFile(file, binary)
  if (!target.startsWith('win32-')) await chmod(file, 0o755)
  return file
}
function build(executable: string, buildArgs: string[]): void {
  const result = Bun.spawnSync({ cmd: [executable, '--no-install', './scripts/build.ts', ...buildArgs], stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error('Runtime delivery build failed')
}
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
const sourceCommit = new TextDecoder().decode(source.stdout).trim()
if (source.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Runtime source commit is required')
process.env.RUNTIME_SOURCE_COMMIT = sourceCommit
await mkdir('./dist', { recursive: true })
const metadata = JSON.parse(await readFile('./package.json', 'utf8')) as { version: string }
await writeFile('./dist/VERSION', metadata.version + '\n')
await writeFile('./dist/COMMIT_SHA', sourceCommit + '\n')
await rm('./dist/opencode-v2-delivery.json', { force: true })
await rm('./dist/opencode-v2-support', { recursive: true, force: true })
await rm('./dist/WINDOWS_CLAUDE_DELIVERY', { force: true })
if (openCodeV2ReleaseDelivery() === 'off') {
  // Never ship residual V2 files from a previous bundled build.
  for (const leftover of ['./dist/opencode-delivery.json', './dist/local-cli', './dist/bun', './dist/build-bun']) {
    await rm(leftover, { recursive: true, force: true })
    if (existsSync(leftover)) throw new Error(`OpenCode V2 delivery survived cleanup: ${leftover}`)
  }
  build(process.execPath, ['--compile', '--without-opencode-v2'])
  if (!existsSync('./dist/cursor-managed')) throw new Error('Managed Cursor assets missing')
  if (platform === 'win32-x64') await writeFile('./dist/WINDOWS_CLAUDE_DELIVERY', 'off\n')
  console.log(`Prepared compiled runtime without OpenCode V2 for ${platform}`)
} else {
  const binary = await pinnedBinary(pins.assets[platform]!, args.includes('--bun-archive') ? option('--bun-archive') : undefined)
  const shipped = await stageBinary('./dist/bun', platform, binary)
  // The physical delivery is parsed by its platform pin. A newer compiler's minifier may
  // emit syntax it cannot parse, so build that JS with the exact shipped version.
  // Cross-compiled assets use the same pinned version's runnable host executable.
  const host = `${process.platform}-${process.arch}`
  if (!Object.hasOwn(pins.assets, host)) throw new Error('Unsupported runtime release build host')
  const jsBuilder = host === platform ? shipped :
    await stageBinary('./dist/build-bun', host, await pinnedBinary(pins.assets[host]!))
  
  const qualified = openCodeV2ReleaseContract().qualified[platform as keyof ReturnType<typeof openCodeV2ReleaseContract>['qualified']]
  if (qualified?.length) {
    build(jsBuilder, ['--opencode-v2-support', '--portable-graph', `--release-platform=${platform}`])
    await packageOpenCodeV2Delivery({ root: './dist/opencode-v2-support', outputDirectory: './dist',
      runtimeVersion: metadata.version, sourceCommit, platformKey: platform })
  }
  build(jsBuilder, ['--base-delivery', `--release-platform=${platform}`])
  const [targetPlatform, arch] = platform.split('-')
  const identity = validatePackagedOpenCodeIdentity({ schema: 1, platform: targetPlatform, arch,
    bunVersion: openCodeBunVersion(targetPlatform), bunSha256: sha(binary), entrySha256: sha(await readFile('./dist/local-cli/cli.js')) })
  await writeFile('./dist/opencode-delivery.json', JSON.stringify(identity, null, 2) + '\n')
  build(process.execPath, ['--compile', '--packaged-delivery', '--base-delivery', `--release-platform=${platform}`])
  console.log(`Prepared graph-free base${qualified?.length ? ' and separate qualified V2 support' : ''} for ${platform}`)
}
