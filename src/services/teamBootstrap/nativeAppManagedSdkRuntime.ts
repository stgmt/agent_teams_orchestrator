import { randomUUID, type UUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { createPendingMailboxMirrorMessage } from '../../hooks/ordinaryMailboxMessage.js'
import {
  buildNativeAttachmentFailureMessage,
  getOrdinaryProcessingAction,
  persistNativeAttachmentFailureReceipt,
  relayOrdinaryMailboxAssistantText,
  type NativeAttachmentFailurePayload,
  type NativeAttachmentFailureReceipt,
  findNativeAppManagedBootstrapAttemptOutcome,
  findOrdinaryAttemptExecutionError,
  getBootstrapPendingMessage,
  getOrdinaryInlineHandoffPrompt,
  getOrdinaryPendingMessage,
  processNativeTeammateMailboxProtocol,
  resolveIncomingMailboxSubmissionKind,
} from '../../hooks/useInboxPoller.js'
import { hasGroupMailboxMarker } from '../../utils/groupMailbox.js'
import {
  finalizeClaimedMessagesAsRead,
  isSilentRegularMailboxMessageForLiveContext,
  markMessagesAsReadByIds,
  readAndClaimInteractiveMailboxSnapshot,
  type TeammateMessage,
} from '../../utils/teammateMailbox.js'
import {
  TEAMMATE_BOOTSTRAP_RUN_ID_ENV,
  writeChildOwnedTeammateRuntimeEvent,
} from '../../utils/swarm/teammateRuntimeEvents.js'
import { QueryGuard } from '../../utils/QueryGuard.js'
import { bindWorkSyncActiveQueryIdentity, clearWorkSyncActiveQueryIdentity } from '../../utils/workSyncActiveQueryIdentity.js'
import {
  armWorkSyncPostTurnAdmissionWindow,
  bindWorkSyncContinuationAdmission,
  isWorkSyncTestConsumeHoldOpen,
  processBoundWorkSyncContinuationAdmission,
  shouldDeferUnticketedWorkSyncNudges,
  unbindWorkSyncContinuationAdmission,
} from '../../utils/workSyncContinuationAdmission.js'
import {
  bindWorkSyncTurnSettledOwnerGate,
  publishStagedWorkSyncTurnSettledIfOwnerReleased,
  unbindWorkSyncTurnSettledOwnerGate,
} from '../../utils/workSyncTurnSettledOwnerGate.js'
import { startQueryForIncomingKind } from '../../utils/incomingPromptAdmission.js'
import { shouldUseCodexProviderRoutingForCurrentProcess } from '../../utils/auth.js'
import {
  isNativeAttachmentMailboxMessage,
  isNativeAttachmentRootReady,
  prepareNativeAttachmentPromptContent,
  NativeAttachmentPreparationError,
} from '../../utils/nativeTeammateAttachments.js'
import { publishNativeInboxRuntimeCapability } from '../../utils/workSyncAdmissionCapability.js'
import {
  buildNativeAppManagedBootstrapPrivatePrompt,
  createNativeAppManagedBootstrapContextInjection,
  isNativeAppManagedBootstrapInstructionText,
  buildNativeAppManagedBootstrapProofFields,
  type NativeAppManagedBootstrapTurnInjection,
} from './nativeAppManagedBootstrapContext.js'
import { logError } from '../../utils/log.js'

export const NATIVE_APP_MANAGED_MAILBOX_PROTOCOL = 'native_app_managed_mailbox'

type NativeSdkMailboxTurn = {
  message: TeammateMessage
  injection: NativeAppManagedBootstrapTurnInjection | null
  protocol: boolean
  submittedAt: number
  finished: boolean
}


/** Adapts shared mailbox claims, protocol owners, query guard and proofs to SDK. */
export function createNativeAppManagedSdkRuntime(input: {
  agentName: string
  agentId?: string
  teamName: string
  sessionId: string
  getMessages: () => Message[]
  setAppState: (update: (previous: AppState) => AppState) => void
  isQueryLoopIdle: () => boolean
  groupChatReady: () => boolean
  submit: (prompt: string | ContentBlockParam[], uuid: UUID) => void
}) {
  const guard = new QueryGuard()
  const getInjection = createNativeAppManagedBootstrapContextInjection()
  const admitted = new Set<string>()
  const turns = new Map<string, NativeSdkMailboxTurn>()
  const attachmentFailures = new Map<string, NativeAttachmentFailureReceipt>()
  let bootstrapConfirmed = false
  let failed = false
  let bound = false
  let attachmentReady = false
  let generation: number | null = null
  const identity = {
    teamName: input.teamName, agentName: input.agentName, agentId: input.agentId,
    runId: input.sessionId,
    bootstrapRunId: process.env[TEAMMATE_BOOTSTRAP_RUN_ID_ENV]?.trim() || undefined,
    source: 'nativeAppManagedSdkRuntime',
  }
  let publishedCapabilityKey: string | undefined
  async function publishCapability() {
    const groupChatReady = input.groupChatReady()
    const key = `${guard.generation}:${attachmentReady}:${groupChatReady}`
    if (key === publishedCapabilityKey) return
    await publishNativeInboxRuntimeCapability({
      guard, teamName: input.teamName, memberName: input.agentName,
      nativeAttachmentsReady: attachmentReady, groupChatReady,
    })
    publishedCapabilityKey = key
  }

  async function publishReady() {
    bindWorkSyncContinuationAdmission({ guard, teamName: input.teamName, memberName: input.agentName })
    bindWorkSyncTurnSettledOwnerGate()
    bound = true
    attachmentReady = await isNativeAttachmentRootReady()
    await publishCapability()
    // Installed processor readiness is not private-turn/bootstrap readiness.
    await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'runtime_ready' })
    await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'inbox_poller_ready' })
  }

  function canAdmitCommand(uuid: string | undefined) {
    return bootstrapConfirmed || Boolean(uuid && turns.get(uuid)?.injection)
  }


  async function flushAttachmentFailures() {
    for (const [messageId, receipt] of attachmentFailures) {
      try {
        await persistNativeAttachmentFailureReceipt(receipt)
        attachmentFailures.delete(messageId)
      } catch (error) {
        // Keep the same immutable USER receipt pending; never re-run its task.
        logError(error)
      }
    }
  }

  async function failAttachment(message: TeammateMessage, reasonCode: NativeAttachmentFailurePayload['reasonCode'], detail: string) {
    if (!attachmentFailures.has(message.messageId)) {
      const payload: NativeAttachmentFailurePayload = {
        message: createPendingMailboxMirrorMessage(message, input.sessionId),
        agentName: input.agentName, teamName: input.teamName,
        sessionId: input.sessionId, reasonCode, detail,
      }
      attachmentFailures.set(message.messageId, {
        ...payload, failureMessage: Object.freeze(buildNativeAttachmentFailureMessage(payload)),
      })
    }
    admitted.add(message.messageId)
    await flushAttachmentFailures()
  }
  async function poll() {
    if (failed) return
    // Protocol resolution and continuation commands must work during a query,
    // including while that query is blocked on a permission prompt.
    if (bound) {
      await processBoundWorkSyncContinuationAdmission()
      await publishCapability()
    }
    await flushAttachmentFailures()
    for (const [uuid, turn] of turns) {
      if (turn.finished) await settleTurn(uuid, turn)
    }
    const snapshot = await readAndClaimInteractiveMailboxSnapshot(
      input.agentName, input.sessionId, input.teamName,
      { excludeMessageIds: [...admitted] },
    )
    const liveProtocol: TeammateMessage[] = []
    for (const message of snapshot.protocolUnread) {
      if (admitted.has(message.messageId) || hasGroupMailboxMarker(message)) continue
      if (await processNativeTeammateMailboxProtocol(message, input.setAppState)) {
        await markMessagesAsReadByIds(input.agentName, [message.messageId], input.teamName)
      } else {
        // The REPL delivers remaining lifecycle protocol (e.g. shutdown) as
        // claimed live context. Do not silently discard protocolUnread.
        liveProtocol.push(message)
      }
    }
    if (turns.size > 0 || !input.isQueryLoopIdle() || isWorkSyncTestConsumeHoldOpen()) return
    const direct = snapshot.regularClaimed.filter(message => !hasGroupMailboxMarker(message))
    const silent = direct.filter(isSilentRegularMailboxMessageForLiveContext)
    await finalizeClaimedMessagesAsRead(input.agentName, silent.map(message => message.messageId), input.sessionId, input.teamName)
    const actionable = direct.filter(message => !isSilentRegularMailboxMessageForLiveContext(message))
    const pending = actionable.map(message => createPendingMailboxMirrorMessage(message, input.sessionId))
    const bootstrap = getBootstrapPendingMessage({ pendingMessages: pending, isTeammateSession: true })
    const ordinary = getOrdinaryPendingMessage({ pendingMessages: pending, deferUnticketedWorkSyncNudges: shouldDeferUnticketedWorkSyncNudges() })
    const selected = bootstrap ? bootstrap : bootstrapConfirmed ? ordinary : undefined
    const message = selected
      ? actionable.find(candidate => candidate.messageId === selected.messageId)
      : bootstrapConfirmed ? liveProtocol[0] : undefined
    if (!message) return
    const protocol = liveProtocol.includes(message)
    const isBootstrap = isNativeAppManagedBootstrapInstructionText(message.text)
    if (isBootstrap && bootstrapConfirmed) {
      admitted.add(message.messageId)
      await finalizeClaimedMessagesAsRead(input.agentName, [message.messageId], input.sessionId, input.teamName)
      return
    }
    const injection = isBootstrap ? await getInjection() : null
    if (isBootstrap && !injection) {
      failed = true
      await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'failed', detail: 'Native app-managed bootstrap context was unavailable.' })
      return
    }
    const uuid = randomUUID()
    const text = isBootstrap ? buildNativeAppManagedBootstrapPrivatePrompt() : getOrdinaryInlineHandoffPrompt({ ...message, teamName: input.teamName, memberName: input.agentName })
    let prompt: string | ContentBlockParam[] = text
    if (isNativeAttachmentMailboxMessage(message)) {
      try {
        prompt = await prepareNativeAttachmentPromptContent({
          message: { ...message, teamName: input.teamName },
          provider: shouldUseCodexProviderRoutingForCurrentProcess() ? 'codex' : 'anthropic',
          replyProtocolText: text, runtimeInstanceId: guard.runtimeInstanceId,
        })
      } catch (error) {
        await failAttachment(message,
          error instanceof NativeAttachmentPreparationError ? error.reasonCode : 'attachment_path_invalid',
          String(error))
        return
      }
    }
    // Identity is admitted once and survives application/socket disconnection.
    admitted.add(message.messageId)
    turns.set(uuid, { message, injection, protocol, submittedAt: Date.now(), finished: false })
    if (injection) {
      await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'bootstrap_prompt_observed', bootstrapMirrorId: message.messageId })
      await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'bootstrap_submitted', runId: injection.runId, bootstrapRunId: injection.runId, bootstrapMirrorId: message.messageId, bootstrapMessageId: uuid })
    }
    input.submit(prompt, uuid)
  }

  async function beforeTurn(uuid: string | undefined) {
    const turn = uuid ? turns.get(uuid) : undefined
    const kind = turn ? resolveIncomingMailboxSubmissionKind({ bootstrapPendingMessage: turn.injection ? turn.message : null, ordinaryPendingMessage: turn.message }) : undefined
    const started = startQueryForIncomingKind({
      incomingKind: kind, continuationTicket: guard.continuationTicket,
      startReservedContinuation: () => {
        const ticket = guard.continuationTicket
        return ticket ? guard.startReservedContinuation(ticket) : { ok: false }
      },
      tryStart: () => guard.tryStart(),
    })
    if (started === null) throw new Error('Native SDK query guard rejected a concurrent turn')
    generation = started
    bindWorkSyncActiveQueryIdentity({ runtimeInstanceId: guard.runtimeInstanceId, completedGeneration: generation })
    if (bound) await publishCapability()
    const injection = turn?.injection
    if (!injection) return false
    input.getMessages().push(...injection.prefixMessages)
    await injection.markContextLoaded()
    return true
  }

  async function releaseTurn() {
    if (generation === null) return
    const released = guard.end(generation)
    generation = null
    await publishStagedWorkSyncTurnSettledIfOwnerReleased(released)
    if (released) armWorkSyncPostTurnAdmissionWindow()
    if (bound) await publishCapability()
  }

  async function settleTurn(uuid: string, turn: NativeSdkMailboxTurn) {
    if (turn.injection) {
      const outcome = findNativeAppManagedBootstrapAttemptOutcome({ messages: input.getMessages(), submitUserMessageUuid: uuid })
      if (outcome.type !== 'confirmed') {
        failed = true
        await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'failed', bootstrapMirrorId: turn.message.messageId, detail: outcome.type === 'fatal' ? outcome.detail : 'Native bootstrap private turn produced no usable response.' })
        throw new Error('Native bootstrap private turn failed')
      }
      const proof = turn.injection
      await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'bootstrap_confirmed', ...buildNativeAppManagedBootstrapProofFields(proof), runId: proof.runId, bootstrapRunId: proof.runId, bootstrapMirrorId: turn.message.messageId })
      bootstrapConfirmed = true
    } else if (findOrdinaryAttemptExecutionError({ messages: input.getMessages(), submitUserMessageUuid: uuid })) {
      if (isNativeAttachmentMailboxMessage(turn.message)) {
        await failAttachment(turn.message, 'attachment_execution_failed', 'Native SDK attachment turn failed.')
        turns.delete(uuid)
        return
      }
      failed = true
      await writeChildOwnedTeammateRuntimeEvent({ ...identity, type: 'failed', detail: 'Native SDK mailbox turn failed; delivery remains unconfirmed.' })
      throw new Error('Native SDK mailbox turn failed')
    } else if (!turn.protocol) {
      const action = getOrdinaryProcessingAction({
        attempt: { submitUserMessageUuid: uuid, submittedAt: turn.submittedAt, cooldownUntil: 0, status: 'in_flight', timer: null },
        messages: input.getMessages(),
        processingOrdinaryMessage: createPendingMailboxMirrorMessage(turn.message, input.sessionId),
        teamName: input.teamName, memberName: input.agentName,
      })
      if (action.type === 'deliver_assistant_text') {
        await relayOrdinaryMailboxAssistantText({ message: turn.message, agentName: input.agentName, teamName: input.teamName, text: action.text })
      } else if (action.type !== 'finalize') {
        // Pending tool/report evidence is not success. Re-observe the same
        // transcript, never invoke the provider again because the app reconnects.
        return
      }
    }
    if (turn.protocol) await markMessagesAsReadByIds(input.agentName, [turn.message.messageId], input.teamName)
    else await finalizeClaimedMessagesAsRead(input.agentName, [turn.message.messageId], input.sessionId, input.teamName)
    turns.delete(uuid)
  }

  async function completeTurn(uuid: string | undefined) {
    await releaseTurn()
    const turn = uuid ? turns.get(uuid) : undefined
    if (!turn || !uuid) return
    turn.finished = true
    await settleTurn(uuid, turn)
  }

  async function close() {
    await releaseTurn()
    if (bound) {
      unbindWorkSyncContinuationAdmission()
      unbindWorkSyncTurnSettledOwnerGate()
      clearWorkSyncActiveQueryIdentity()
      bound = false
    }
  }

  return { publishReady, poll, canAdmitCommand, beforeTurn, releaseTurn, completeTurn, close }
}
