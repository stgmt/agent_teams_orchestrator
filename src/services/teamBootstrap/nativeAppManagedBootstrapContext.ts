import { createHash, randomUUID } from 'crypto'
import { lstat, readFile } from 'fs/promises'
import { join } from 'path'

import { errorMessage } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { getTeamDir, sanitizeName } from '../../utils/swarm/teamHelpers.js'
import type { BootstrapProvider } from './teamBootstrapTypes.js'
import type { AppState } from '../../state/AppState.js'
import { createUserMessage } from '../../utils/messages.js'
import { writeTeammateRuntimeEvent } from '../../utils/swarm/teammateRuntimeEvents.js'

export const NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV =
  'CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH'
export const NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_SOURCE =
  'native_app_managed_bootstrap_context_loaded'
export const NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE =
  'native_app_managed_bootstrap_private_turn'

const NATIVE_APP_MANAGED_BOOTSTRAP_MARKER =
  '<agent_teams_native_app_managed_bootstrap_check>'
const MAX_NATIVE_CONTEXT_FILE_BYTES = 96 * 1024

export type NativeAppManagedBootstrapSpec = {
  schemaVersion: 1
  mode: 'startup_context_file'
  contextText: string
  contextHash: string
  briefingHash: string
  generatedAt: string
}

export type NativeAppManagedBootstrapContextFile = NativeAppManagedBootstrapSpec & {
  kind: 'native_app_managed_bootstrap'
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  bootstrapProofToken: string
}

export type NativeAppManagedBootstrapContextInjection = {
  prefixMessagesText: string
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  contextHash: string
  briefingHash: string
  bootstrapProofToken: string
  generatedAt: string
}

export function isNativeAppManagedBootstrapProvider(
  provider?: BootstrapProvider,
): boolean {
  return provider === undefined || provider === 'anthropic' || provider === 'codex'
}

export function canonicalizeNativeBootstrapContextText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export function hashNativeBootstrapText(input: string): string {
  return createHash('sha256')
    .update(canonicalizeNativeBootstrapContextText(input))
    .digest('hex')
}

export function isNativeAppManagedBootstrapInstructionText(text: string): boolean {
  return text.includes(NATIVE_APP_MANAGED_BOOTSTRAP_MARKER)
}

export function buildNativeAppManagedBootstrapPrivatePrompt(): string {
  return [
    NATIVE_APP_MANAGED_BOOTSTRAP_MARKER,
    'Your Agent Teams startup context was already loaded by the app.',
    'Do not call member_briefing for launch readiness.',
    'Do not send readiness, acknowledgement, idle, or no-task messages to the user, lead, or teammates.',
    'For bootstrap proof, first output exactly this private local text line: Startup context loaded.',
    'This local proof line is not sent to the user, lead, or teammates and does not violate the no-message rule.',
    'Do not output "(no content)" or an empty response; that is a bootstrap failure.',
    'Then follow the loaded startup context: if it shows Actionable assigned work for you, do not stop after the proof line; use the task tools and task protocol in this same turn. If it shows no Actionable work, stop after the proof line and wait silently.',
    '</agent_teams_native_app_managed_bootstrap_check>',
  ].join('\n')
}

export function buildNativeAppManagedBootstrapPrefixText(
  context: NativeAppManagedBootstrapContextFile,
): string {
  return canonicalizeNativeBootstrapContextText([
    '<agent_teams_native_bootstrap_control>',
    'System-level bootstrap rules:',
    '- This is a private startup context handoff.',
    '- Do not send readiness, acknowledgement, idle, or no-task messages to user, lead, or teammates.',
    '- Do not call member_briefing for launch readiness.',
    '- For bootstrap proof, first output exactly this private local text line: Startup context loaded.',
    '- This local proof line is not sent to user, lead, or teammates and does not violate the no-message rule.',
    '- Do not output "(no content)" or an empty response; that is a bootstrap failure.',
    '- Then follow the loaded startup context: if it shows Actionable assigned work for you, do not stop after the proof line; use the task tools and task protocol in this same turn. If it shows no Actionable work, stop after the proof line and wait silently.',
    '</agent_teams_native_bootstrap_control>',
    '',
    '<agent_teams_native_bootstrap_context_data>',
    context.contextText,
    '</agent_teams_native_bootstrap_context_data>',
  ].join('\n'))
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`native app-managed bootstrap context missing ${field}`)
  }
  return value.trim()
}

export async function readNativeAppManagedBootstrapContextFile(
  filePath: string,
): Promise<NativeAppManagedBootstrapContextFile> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('native app-managed bootstrap context must be a regular file')
  }
  if (stat.size > MAX_NATIVE_CONTEXT_FILE_BYTES) {
    throw new Error('native app-managed bootstrap context is too large')
  }

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native app-managed bootstrap context must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'native_app_managed_bootstrap' ||
    record.mode !== 'startup_context_file'
  ) {
    throw new Error('native app-managed bootstrap context has unsupported schema')
  }

  const contextText = requireString(record, 'contextText')
  const contextHash = requireString(record, 'contextHash')
  const briefingHash = requireString(record, 'briefingHash')
  if (hashNativeBootstrapText(contextText) !== contextHash) {
    throw new Error('native app-managed bootstrap context hash mismatch')
  }

  const providerRaw = record.provider
  const provider =
    providerRaw === 'anthropic' || providerRaw === 'codex' || providerRaw === 'gemini'
      ? providerRaw
      : undefined
  if (!isNativeAppManagedBootstrapProvider(provider)) {
    throw new Error(`native app-managed bootstrap unsupported provider: ${String(providerRaw)}`)
  }

  return {
    schemaVersion: 1,
    kind: 'native_app_managed_bootstrap',
    mode: 'startup_context_file',
    teamName: requireString(record, 'teamName'),
    memberName: requireString(record, 'memberName'),
    agentId: requireString(record, 'agentId'),
    runId: requireString(record, 'runId'),
    ...(provider ? { provider } : {}),
    contextText,
    contextHash,
    briefingHash,
    generatedAt: requireString(record, 'generatedAt'),
    bootstrapProofToken: requireString(record, 'bootstrapProofToken'),
  }
}

export async function prepareNativeAppManagedBootstrapContextFile(params: {
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  bootstrapProofToken: string
  spec?: NativeAppManagedBootstrapSpec
}): Promise<Record<string, string>> {
  if (!params.spec || !isNativeAppManagedBootstrapProvider(params.provider)) {
    return {}
  }

  const context: NativeAppManagedBootstrapContextFile = {
    ...params.spec,
    kind: 'native_app_managed_bootstrap',
    teamName: params.teamName,
    memberName: params.memberName,
    agentId: params.agentId,
    runId: params.runId,
    ...(params.provider ? { provider: params.provider } : {}),
    bootstrapProofToken: params.bootstrapProofToken,
  }
  if (hashNativeBootstrapText(context.contextText) !== context.contextHash) {
    throw new Error(`Native app-managed bootstrap context hash mismatch for ${params.memberName}`)
  }

  const dir = join(getTeamDir(params.teamName), 'runtime', 'native-bootstrap')
  const finalPath = join(
    dir,
    `${sanitizeName(params.memberName)}-${randomUUID()}.native-bootstrap.json`,
  )
  await writeJsonFileAtomic(finalPath, context, { mode: 0o600 })
  return { [NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]: finalPath }
}

export async function loadNativeAppManagedBootstrapContextInjection(
  filePath: string,
): Promise<NativeAppManagedBootstrapContextInjection> {
  try {
    const context = await readNativeAppManagedBootstrapContextFile(filePath)
    return {
      prefixMessagesText: buildNativeAppManagedBootstrapPrefixText(context),
      teamName: context.teamName,
      memberName: context.memberName,
      agentId: context.agentId,
      runId: context.runId,
      ...(context.provider ? { provider: context.provider } : {}),
      contextHash: context.contextHash,
      briefingHash: context.briefingHash,
      bootstrapProofToken: context.bootstrapProofToken,
      generatedAt: context.generatedAt,
    }
  } catch (error) {
    logForDebugging(
      `[native-bootstrap] failed to load app-managed context: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    throw error
  }
}

export type NativeAppManagedBootstrapTurnInjection = {
  prefixMessages: AppState['messages']
  contextHash: string
  briefingHash: string
  bootstrapProofToken: string
  runId: string
  markContextLoaded: () => Promise<void>
}

export type GetNativeAppManagedBootstrapContextInjection = () => Promise<
  NativeAppManagedBootstrapTurnInjection | null
>

export function buildNativeAppManagedBootstrapProofFields(proof: {
  bootstrapProofToken: string
  contextHash: string
  briefingHash: string
  runId: string
}) {
  return {
    source: NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE,
    bootstrapProofToken: proof.bootstrapProofToken,
    contextHash: proof.contextHash,
    briefingHash: proof.briefingHash,
    detail: JSON.stringify({
      source: NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE,
      bootstrapProofToken: proof.bootstrapProofToken,
      contextHash: proof.contextHash,
      briefingHash: proof.briefingHash,
      runId: proof.runId,
    }),
  }
}

/** The same process-owned context handoff is used by REPL and native SDK turns. */
export function createNativeAppManagedBootstrapContextInjection(): GetNativeAppManagedBootstrapContextInjection {
  let loadPromise: Promise<NativeAppManagedBootstrapContextInjection | null> | null = null
  let contextLoadedWritten = false
  return async () => {
    const contextPath = process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
    if (!contextPath) return null
    loadPromise ??= loadNativeAppManagedBootstrapContextInjection(contextPath).catch(async error => {
      await writeTeammateRuntimeEvent({
        type: 'failed',
        detail: `Native app-managed bootstrap context failed to load: ${errorMessage(error)}`,
      })
      return null
    })
    const injection = await loadPromise
    if (!injection) return null
    return {
      prefixMessages: [createUserMessage({ content: injection.prefixMessagesText, isMeta: true })],
      contextHash: injection.contextHash,
      briefingHash: injection.briefingHash,
      bootstrapProofToken: injection.bootstrapProofToken,
      runId: injection.runId,
      markContextLoaded: async () => {
        if (contextLoadedWritten) return
        await writeTeammateRuntimeEvent({
          type: 'bootstrap_context_loaded',
          teamName: injection.teamName,
          agentName: injection.memberName,
          agentId: injection.agentId,
          runId: injection.runId,
          source: NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_SOURCE,
          bootstrapProofToken: injection.bootstrapProofToken,
          contextHash: injection.contextHash,
          briefingHash: injection.briefingHash,
          detail: JSON.stringify({ contextHash: injection.contextHash, briefingHash: injection.briefingHash }),
        })
        contextLoadedWritten = true
      },
    }
  }
}
