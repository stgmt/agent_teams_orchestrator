import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { buildWorkSyncAdmissionRoot } from './workSyncContinuationAdmission.js'
import type { QueryGuard } from './QueryGuard.js'
import { shouldUseCodexProviderRoutingForCurrentProcess } from './auth.js'
import { getCurrentGroupRunIdentity } from './groupMailbox.js'

export type WorkSyncAdmissionProviderId = 'codex' | 'anthropic'

export type WorkSyncAdmissionCapability = {
  schemaVersion: 1
  recoveryProtocolVersion: 2
  teamName: string
  teamIncarnation: string
  memberName: string
  providerId: WorkSyncAdmissionProviderId
  runtimeMode: 'app-server' | 'repl'
  runtimeInstanceId: string
  generation: number
  processorReady: true
  groupChatProtocolVersion?: 1
  groupReactionProtocolVersion?: 1
  groupRunKey?: string
  runKey?: string
  bootstrapRunId?: string
  runtimeRunId?: string
  pid?: number
  nativeInboxAttachmentsVersion?: 1 | 2
  publishedAt: string
}

type CapabilityPublicationState = {
  runtimeInstanceId: string
  sawAttachmentReady: boolean
  tail: Promise<void>
}

const capabilityPublications = new Map<string, CapabilityPublicationState>()

export function buildWorkSyncAdmissionCapabilityPath(input: {
  teamName: string
  memberName: string
  teamsDir?: string
}): string {
  return join(
    buildWorkSyncAdmissionRoot({
      teamName: input.teamName,
      memberName: input.memberName,
      teamsDir: input.teamsDir,
    }),
    'capability.json',
  )
}

export async function writeWorkSyncAdmissionCapability(
  capability: WorkSyncAdmissionCapability,
  teamsDir?: string,
): Promise<string> {
  const path = buildWorkSyncAdmissionCapabilityPath({
    teamName: capability.teamName,
    memberName: capability.memberName,
    teamsDir,
  })
  const previous = capabilityPublications.get(path)
  const attachmentReady =
    capability.nativeInboxAttachmentsVersion === 1 ||
    capability.nativeInboxAttachmentsVersion === 2
  if (
    previous?.sawAttachmentReady &&
    previous.runtimeInstanceId === capability.runtimeInstanceId &&
    !attachmentReady
  ) {
    return path
  }
  const state: CapabilityPublicationState = {
    runtimeInstanceId: capability.runtimeInstanceId,
    sawAttachmentReady:
      (previous?.runtimeInstanceId === capability.runtimeInstanceId &&
        previous.sawAttachmentReady) ||
      attachmentReady,
    tail: previous?.tail ?? Promise.resolve(),
  }
  capabilityPublications.set(path, state)
  const publication = state.tail.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(capability)}\n`, 'utf8')
  })
  state.tail = publication.catch(() => undefined)
  await publication
  return path
}
/** Shared assembly for the REPL and SDK owners; readiness comes from installed owners. */
export async function publishNativeInboxRuntimeCapability(input: {
  guard: QueryGuard
  teamName: string
  memberName: string
  nativeAttachmentsReady: boolean
  groupChatReady: boolean
}) {
  const providerId = shouldUseCodexProviderRoutingForCurrentProcess() ? 'codex' : 'anthropic'
  const identity = getCurrentGroupRunIdentity()
  return writeWorkSyncAdmissionCapability({
    schemaVersion: 1, recoveryProtocolVersion: 2,
    teamName: input.teamName,
    teamIncarnation: process.env.CLAUDE_TEAM_INCARNATION?.trim() || 'unspecified',
    memberName: input.memberName, providerId,
    runtimeMode: providerId === 'codex' ? 'app-server' : 'repl',
    runtimeInstanceId: input.guard.runtimeInstanceId,
    generation: input.guard.generation, processorReady: true,
    pid: identity.pid, bootstrapRunId: identity.bootstrapRunId,
    runtimeRunId: identity.runtimeRunId,
    ...(input.nativeAttachmentsReady ? { nativeInboxAttachmentsVersion: 2 as const } : {}),
    ...(input.groupChatReady ? { groupChatProtocolVersion: 1 as const, groupReactionProtocolVersion: 1 as const, groupRunKey: identity.groupRunKey, runKey: identity.runKey } : {}),
    publishedAt: new Date().toISOString(),
  })
}
