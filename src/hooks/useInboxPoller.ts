import { buildGroupMailboxPrompt, findGroupMailboxReplyOutcome, hasConflictingGroupReplyScope, hasGroupMailboxMarker, isCurrentGroupMailboxMessage, type GroupMailboxEnvelope, type GroupMailboxHistoryMessage, type GroupMailboxHostTurn, type GroupMailboxOwnPostProof, findGroupMailboxOwnPostProofs } from '../utils/groupMailbox.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { readFreshGroupChatCatalog, relayGroupAssistantText } from '../utils/groupChatControlClient.js'
import { createHash, randomUUID } from 'crypto'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import { createPendingMailboxMirrorMessage, isHumanDirectMailboxMessage } from './ordinaryMailboxMessage.js'
import { getSessionId } from '../bootstrap/state.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
export { isBootstrapMailboxInstructionText } from '../services/teamBootstrap/teamBootstrapMemberBriefingGuard.js'
import { isBootstrapMailboxInstructionText } from '../services/teamBootstrap/teamBootstrapMemberBriefingGuard.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import type { Tool } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { assembleToolPool, getAllBaseTools } from '../tools.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { shouldUseCodexProviderRoutingForCurrentProcess } from '../utils/auth.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import type { IncomingPromptSubmissionKind } from '../utils/incomingPromptAdmission.js'
import {
  classifyTicketedWorkSyncEnvelope,
  getOrdinaryPendingMessage,
} from '../utils/ordinaryPendingMailboxMessage.js'
import {
  getBoundWorkSyncContinuationTicket,
  getWorkSyncIdleDeliveryRetryDelayMs,
  isWorkSyncPostTurnAdmissionWindowOpen,
  isWorkSyncTestConsumeHoldOpen,
  processBoundWorkSyncContinuationAdmission,
  shouldDeferUnticketedWorkSyncNudges,
} from '../utils/workSyncContinuationAdmission.js'
import {
  readWorkSyncInboxContinuationTicket,
} from '../utils/workSyncInboxTicket.js'
import { createAssistantMessage, isEmptyMessageText } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolSearchEnabledOptimistic } from '../utils/toolSearch.js'
import { getCwd } from '../utils/cwd.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import {
  isPaneBackend,
  type BackendType,
} from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { killProcessBackendRuntime } from '../utils/swarm/processBackend.js'
import {
  TEAMMATE_BOOTSTRAP_RUN_ID_ENV,
  writeChildOwnedTeammateRuntimeEvent,
} from '../utils/swarm/teammateRuntimeEvents.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import {
  readTeamFile,
  removeTeammateFromTeamFile,
  setMemberMode,
} from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeamName,
  getTeammateColor,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  finalizeClaimedMessagesAsRead,
  isLegacyPlanApprovalResponseMessage,
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isAgentErrorNotificationMessage,
  isLiveInboxMirrorMessageOwnedBySession,
  isRegularInteractiveMailboxMessage,
  isSilentRegularMailboxMessageForLiveContext,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  markMessagesAsReadByIds,
  readAndClaimInteractiveMailboxSnapshot,
  readGroupMailboxContext,
  type TeammateMessage,
  writeToMailbox,
  writeToMailboxVerified,
} from '../utils/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'
import type { GetNativeAppManagedBootstrapContextInjection } from './useNativeAppManagedBootstrapContextInjection.js'
import type { CodexNativeConversationScope } from '../services/codexNative/conversationScope.js'
import {
  buildNativeAppManagedBootstrapPrivatePrompt,
  isNativeAppManagedBootstrapInstructionText,
  buildNativeAppManagedBootstrapProofFields,
} from '../services/teamBootstrap/nativeAppManagedBootstrapContext.js'
import {
  isNativeAttachmentMailboxMessage,
  isNativeAttachmentRootReady,
  NativeAttachmentPreparationError,
  prepareNativeAttachmentPromptContent,
  type NativeAttachmentFailureReason,
  type NativeAttachmentProvider,
} from '../utils/nativeTeammateAttachments.js'

/**
 * Get the agent name to poll for messages.
 * - In-process teammates return undefined (they use waitForNextPromptOrShutdown instead)
 * - Process-based teammates use their CLAUDE_CODE_AGENT_NAME
 * - Team leads use their name from teamContext.teammates
 * - Standalone sessions return undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // In-process teammates should NOT use useInboxPoller - they have their own
  // polling mechanism via waitForNextPromptOrShutdown() in inProcessRunner.ts.
  // Using useInboxPoller would cause message routing issues since in-process
  // teammates share the same React context and AppState with the leader.
  //
  // Note: This can be called when the leader's REPL re-renders while an
  // in-process teammate's AsyncLocalStorage context is active (due to shared
  // setAppState). We return undefined to gracefully skip polling rather than
  // throwing, since this is a normal occurrence during concurrent execution.
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // Team lead polls using their agent name (not ID)
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // Look up the lead's name from teammates map
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000
const BOOTSTRAP_RETRY_COOLDOWN_MS = 5000
const ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS = 5000
const ORDINARY_DIRECT_MESSAGE_IN_FLIGHT_STALL_MS = 2 * 60 * 1000
const MEMBER_WORK_SYNC_NUDGE_RETRY_COOLDOWN_MS = 2 * 60 * 1000
const MEMBER_WORK_SYNC_NUDGE_IN_FLIGHT_STALL_MS = 2 * 60 * 1000
const ORDINARY_DIRECT_MESSAGE_MAX_AUTO_RECOVERY_ATTEMPTS = 1
const BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS = 15000
// Native mailbox poller only. OpenCode runtime delivery is direct bridge prompt
// relay and must not reuse SendMessage-based mailbox prompts.
const MEMBER_BRIEFING_TOOL_NAME = 'member_briefing'
const PREFIXED_MEMBER_BRIEFING_TOOL_NAME = 'mcp__agent-teams__member_briefing'
const CODEX_NATIVE_EXEC_TIMEOUT_ERROR_TEXT = 'codex native exec timed out'

export function isMemberBriefingToolName(name: string): boolean {
  return (
    name === MEMBER_BRIEFING_TOOL_NAME ||
    name === PREFIXED_MEMBER_BRIEFING_TOOL_NAME
  )
}

export type InboxPromptSubmitResult = {
  accepted: boolean
  userMessageUuid?: string
  rejectionReason?: 'bootstrap_pending' | 'query_active' | 'command_queue_busy'
  queryGuardActive?: boolean
  queryGuardStatus?: 'idle' | 'dispatching' | 'running'
  commandQueueLength?: number
  commandQueueModes?: string[]
}

export type InboxPromptSubmitOptions = {
  isMeta?: boolean
  prefixMessages?: AppState['messages']
  submissionKind?: IncomingPromptSubmissionKind
  conversationScope?: CodexNativeConversationScope
}

export type NativeInboxAttachmentsReadiness = {
  pid: number
  bootstrapRunId: string
  runtimeRunId: string
}

export type NativeAttachmentFailurePayload = {
  message: PendingInboxMirrorMessage
  agentName: string
  teamName?: string
  sessionId: string
  reasonCode:
    | NativeAttachmentFailureReason
    | 'attachment_submission_uncorrelated'
    | 'attachment_execution_failed'
  detail: string
}

export type AgentErrorUserNotification = Pick<
  TeammateMessage,
  'messageId' | 'from' | 'text' | 'timestamp' | 'color' | 'summary' | 'messageKind'
> & { messageKind: 'agent_error' }

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  getMessages: () => AppState['messages']
  transcriptActivitySignature: string
  runtimeInstanceId: string
  // Returns true if submission succeeded, false if rejected (e.g., query already running)
  // Dead code elimination: parameter named onSubmitMessage to avoid "teammate" string in external builds
  onSubmitMessage: (
    formatted: string | ContentBlockParam[],
    options?: InboxPromptSubmitOptions,
  ) => InboxPromptSubmitResult
  getNativeAppManagedBootstrapContextInjection?: GetNativeAppManagedBootstrapContextInjection
  onAgentErrorNotification: (message: AgentErrorUserNotification) => void
  onBootstrapConfirmed: () => void
  onNativeInboxAttachmentsReady?: (
    readiness: NativeInboxAttachmentsReadiness,
  ) => void
  isIncomingPromptIdle?: () => boolean
}

function formatPromptSubmitRejectionDetail(submitted: InboxPromptSubmitResult): string {
  const reason = submitted.rejectionReason ?? 'unknown'
  const queueLength =
    typeof submitted.commandQueueLength === 'number' && Number.isFinite(submitted.commandQueueLength)
      ? submitted.commandQueueLength
      : undefined
  const queueModes = submitted.commandQueueModes?.length
    ? submitted.commandQueueModes.join(',')
    : undefined
  return [
    `submit rejected by local prompt handler`,
    `reason=${reason}`,
    typeof submitted.queryGuardActive === 'boolean'
      ? `queryGuardActive=${submitted.queryGuardActive}`
      : undefined,
    submitted.queryGuardStatus ? `queryGuardStatus=${submitted.queryGuardStatus}` : undefined,
    queueLength != null ? `commandQueueLength=${queueLength}` : undefined,
    queueModes ? `commandQueueModes=${queueModes}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join('; ')
}

function formatBootstrapMessageAgeMs(timestamp: string | undefined, now: number): string | undefined {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
  if (!Number.isFinite(parsed)) {
    return undefined
  }
  return String(Math.max(0, now - parsed))
}

export type PendingInboxMirrorMessage = Pick<
  AppState['inbox']['messages'][number],
  | 'id'
  | 'messageId'
  | 'mailboxClaimedBySessionId'
  | 'from'
  | 'text'
  | 'timestamp'
  | 'status'
> &
  GroupMailboxEnvelope & Partial<Pick<AppState['inbox']['messages'][number],
    'messageKind' | 'source' | 'workSyncRuntimeTicketId' | 'workSyncRuntimeGeneration' |
    'workSyncRuntimeInstanceId' | 'workSyncIntentId' | 'workSyncAdmissionPayloadHash' | 'workSyncControlRevision'>>
  & Partial<Pick<AppState['inbox']['messages'][number],
    'attachments' | 'nativeAttachmentDelivery'>>

type QueuedMailboxPromptMessage = Pick<PendingInboxMirrorMessage, 'from' | 'text'>

const GENERIC_QUEUED_MAILBOX_META_PROMPT =
  'Process the queued teammate mailbox attachment for this turn.'

export type OrdinaryUserDirectReplyProtocol =
  | 'send_message'
  | 'agent_teams_message_send'

const CODEX_AGENT_TEAMS_MCP_TOOL_HINT = [
  'For Agent Teams task and work-sync tools in this Codex-native handoff, call the exposed MCP tool directly.',
  'If tool search exposes prefixed names, use mcp__agent-teams__task_get, mcp__agent-teams__task_start, mcp__agent-teams__task_add_comment, mcp__agent-teams__task_complete, mcp__agent-teams__member_work_sync_status, and mcp__agent-teams__member_work_sync_report.',
  'Do not run shell searches or list MCP resources just to discover these known Agent Teams tools before the first direct tool attempt.',
].join(' ')

export function resolveOrdinaryUserDirectReplyProtocol(
  entryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER,
): OrdinaryUserDirectReplyProtocol {
  return entryProvider?.trim().toLowerCase() === 'codex'
    ? 'agent_teams_message_send'
    : 'send_message'
}

export function getQueuedMailboxMetaPrompt({
  pendingMessages,
  isTeammateSession,
}: {
  pendingMessages: readonly QueuedMailboxPromptMessage[]
  isTeammateSession: boolean
}): string {
  const hasBootstrapInstruction =
    isTeammateSession &&
    pendingMessages.some(
      message =>
        message.from === TEAM_LEAD_NAME &&
        isBootstrapMailboxInstructionText(message.text),
    )

  if (!hasBootstrapInstruction) {
    return GENERIC_QUEUED_MAILBOX_META_PROMPT
  }

  return [
    'Process the queued teammate mailbox attachment now.',
    'It contains your onboarding/bootstrap instructions from the team lead.',
    'Follow the attachment immediately.',
    'If it instructs member_briefing, call the MCP tool member_briefing on the agent-teams server now.',
    'Do not run a shell command named member_briefing.',
    'If agent-teams is still connecting, wait briefly and retry tool search at most once; if member_briefing is still unavailable after that, report the exact error once to team-lead and wait.',
    'Do not ask for clarification if the attachment is present and readable.',
    'After bootstrap completes, continue with normal team mailbox and task behavior.',
  ].join(' ')
}

export function getBootstrapPendingMessage({
  pendingMessages,
  isTeammateSession,
}: {
  pendingMessages: readonly PendingInboxMirrorMessage[]
  isTeammateSession: boolean
}): PendingInboxMirrorMessage | undefined {
  if (!isTeammateSession) {
    return undefined
  }

  let selected: PendingInboxMirrorMessage | undefined
  for (const message of pendingMessages) {
    if (
      message.status !== 'pending' ||
      message.from !== TEAM_LEAD_NAME ||
      !isBootstrapMailboxInstructionText(message.text)
    ) {
      continue
    }
    selected = message
  }
  return selected
}

export function getBootstrapMessageIdsToFinalize({
  messages,
}: {
  messages: readonly PendingInboxMirrorMessage[]
}): string[] {
  return [
    ...new Set(
      messages
        .filter(
          (
            message,
          ): message is PendingInboxMirrorMessage & { messageId: string } =>
            typeof message.messageId === 'string' &&
            message.messageId.length > 0 &&
            message.from === TEAM_LEAD_NAME &&
            isBootstrapMailboxInstructionText(message.text),
        )
        .map(message => message.messageId),
    ),
  ]
}

export function getBootstrapProcessingMessage({
  messages,
}: {
  messages: readonly PendingInboxMirrorMessage[]
}): PendingInboxMirrorMessage | undefined {
  let newestActiveBootstrap: PendingInboxMirrorMessage | undefined
  for (const message of messages) {
    if (
      message.from !== TEAM_LEAD_NAME ||
      !isBootstrapMailboxInstructionText(message.text)
    ) {
      continue
    }
    if (message.status !== 'pending' && message.status !== 'processing') {
      continue
    }
    newestActiveBootstrap = message
  }
  return newestActiveBootstrap?.status === 'processing' &&
    !!newestActiveBootstrap.messageId
    ? newestActiveBootstrap
    : undefined
}

export {
  classifyTicketedWorkSyncEnvelope,
  getOrdinaryPendingMessage,
} from '../utils/ordinaryPendingMailboxMessage.js'

export function resolveIncomingMailboxSubmissionKind(input: {
  bootstrapPendingMessage?: { messageId?: string } | null
  ordinaryPendingMessage?: Parameters<typeof readWorkSyncInboxContinuationTicket>[0]
}): IncomingPromptSubmissionKind {
  if (input.bootstrapPendingMessage) {
    return 'bootstrap'
  }
  const ticket = input.ordinaryPendingMessage
    ? readWorkSyncInboxContinuationTicket(input.ordinaryPendingMessage)
    : null
  return ticket ? 'work_sync_continuation' : 'mailbox'
}

function shouldHoldTicketedWorkSyncUntilExactMatch(message: {
  messageKind?: string
  messageId?: string
  workSyncRuntimeTicketId?: string
  workSyncRuntimeGeneration?: number
  workSyncRuntimeInstanceId?: string
  workSyncIntentId?: string
  workSyncAdmissionPayloadHash?: string
}): boolean {
  return classifyTicketedWorkSyncEnvelope(message) === 'wait'
}

export function getProcessingOrdinaryMessage({
  messages,
  getAttemptStatus,
  shouldProcessCoolingDown,
}: {
  messages: readonly PendingInboxMirrorMessage[]
  getAttemptStatus: (messageId: string) => 'in_flight' | 'cooling_down' | undefined
  shouldProcessCoolingDown?: (message: PendingInboxMirrorMessage) => boolean
}): PendingInboxMirrorMessage | undefined {
  return messages.find(message => {
    if (message.status !== 'processing' || !message.messageId) {
      return false
    }
    const attemptStatus = getAttemptStatus(message.messageId)
    return (
      attemptStatus !== 'cooling_down' ||
      shouldProcessCoolingDown?.(message) === true
    )
  })
}

export function getOrdinaryInboxDeliveryState(
  messages: readonly PendingInboxMirrorMessage[],
  pendingNativeFailureIds: ReadonlySet<string>,
): { actionableMessages: PendingInboxMirrorMessage[]; ownedMessageIds: Set<string> } {
  const actionableMessages = messages.filter(message =>
    !pendingNativeFailureIds.has(message.messageId ?? '') &&
    message.messageKind !== 'agent_error' &&
    isRegularInteractiveMailboxMessage(message) &&
    !(message.from === TEAM_LEAD_NAME && isBootstrapMailboxInstructionText(message.text)),
  )
  return {
    actionableMessages,
    // A pending durable failure retains ownership without becoming actionable.
    ownedMessageIds: new Set([
      ...pendingNativeFailureIds,
      ...actionableMessages.map(message => message.messageId)
        .filter((messageId): messageId is string => !!messageId),
    ]),
  }
}

export function shouldDeferPendingInboxDelivery(params: {
  isLoading: boolean
  focusedInputDialog: string | undefined
  isTeammateSession: boolean
  pendingMessages: readonly PendingInboxMirrorMessage[]
}): boolean {
  if (params.focusedInputDialog) {
    return true
  }

  if (isWorkSyncTestConsumeHoldOpen()) {
    const ticketed = getOrdinaryPendingMessage({
      pendingMessages: params.pendingMessages,
      deferUnticketedWorkSyncNudges: true,
    })
    if (
      ticketed?.messageKind === 'member_work_sync_nudge' &&
      readWorkSyncInboxContinuationTicket(ticketed)
    ) {
      return true
    }
  }

  if (params.isLoading) {
    const ticketed = getOrdinaryPendingMessage({
      pendingMessages: params.pendingMessages,
      deferUnticketedWorkSyncNudges: true,
    })
    if (
      ticketed?.messageKind === 'member_work_sync_nudge' &&
      readWorkSyncInboxContinuationTicket(ticketed) &&
      !shouldHoldTicketedWorkSyncUntilExactMatch(ticketed)
    ) {
      return false
    }
    const bootstrapPendingMessage = getBootstrapPendingMessage({
      pendingMessages: params.pendingMessages,
      isTeammateSession: params.isTeammateSession,
    })
    return bootstrapPendingMessage == null
  }

  if (
    isWorkSyncPostTurnAdmissionWindowOpen() &&
    !getBoundWorkSyncContinuationTicket()
  ) {
    return true
  }

  return false
}

export function getBootstrapInlineHandoffPrompt({
  bootstrapInstructionText,
  teamName,
  memberName,
}: {
  bootstrapInstructionText: string
  teamName?: string
  memberName?: string
}): string | null {
  if (!teamName || !memberName) {
    return null
  }
  const useCodexMcpReply = resolveOrdinaryUserDirectReplyProtocol() === 'agent_teams_message_send'
  const bootstrapFailureInstruction = useCodexMcpReply
    ? `If member_briefing is still unavailable after that one retry, send exactly one short message to "team-lead" via agent-teams_message_send or mcp__agent-teams__message_send with teamName="${teamName}", to="team-lead", from="${memberName}", text, and summary, then stop this turn and wait. Do not use SendMessage for this Codex-native bootstrap failure report.`
    : 'If member_briefing is still unavailable after that one retry, send exactly one short SendMessage to "team-lead" with the exact error text, then stop this turn and wait.'

  return [
    `You are bootstrapping into team "${teamName}" as member "${memberName}".`,
    `Your first action is to call the MCP tool member_briefing on the agent-teams server with teamName="${teamName}" and memberName="${memberName}".`,
    'If tool search shows only the prefixed MCP name, use mcp__agent-teams__member_briefing.',
    'Call the MCP tool directly yourself. Do not run a shell command named member_briefing. Do not use Agent, any subagent, or a delegated helper for this bootstrap step.',
    'Do not explore files, inbox paths, or team config before the first member_briefing attempt.',
    'If tool search says agent-teams is still connecting, wait briefly and retry tool search at most once.',
    bootstrapFailureInstruction,
    'Do not keep searching for member_briefing, do not check tasks, and do not send repeated status or idle messages after reporting the bootstrap failure.',
    'Bootstrap instructions from team-lead:',
    '<bootstrap_instructions>',
    bootstrapInstructionText,
    '</bootstrap_instructions>',
  ].join('\n')
}

export function shouldSkipBootstrapReadinessWait(params: {
  bootstrapInstructionText: string
  teamName?: string
  memberName?: string
  toolCallableNow: boolean
}): boolean {
  if (params.toolCallableNow) {
    return true
  }

  return false
}

export function getOrdinaryInlineHandoffPrompt({
  from,
  to,
  source,
  memberName,
  messageId,
  replyProtocol = resolveOrdinaryUserDirectReplyProtocol(),
  text,
  teamName,
  timestamp,
  groupCatalog,
  groupHistory,
  groupSentHistory,
  groupOwnPosts,
  ...groupEnvelope
}: GroupMailboxEnvelope & {
  from: string
  to?: string
  source?: string
  memberName?: string
  messageId?: string
  replyProtocol?: OrdinaryUserDirectReplyProtocol
  groupCatalog?: unknown
  groupHistory?: readonly GroupMailboxHistoryMessage[]
  groupSentHistory?: readonly GroupMailboxHistoryMessage[]
  groupOwnPosts?: readonly GroupMailboxOwnPostProof[]
  text: string
  teamName?: string
  timestamp: string
}): string {
  if (hasGroupMailboxMarker(groupEnvelope)) {
    return buildGroupMailboxPrompt({ ...groupEnvelope, from, to, messageId, text, timestamp }, teamName, memberName, groupCatalog, groupHistory, groupSentHistory, groupOwnPosts)
  }
  const isUserMessage = isHumanDirectMailboxMessage({ from, source })
  const normalizedTeamName = teamName?.trim()
  const normalizedMemberName = memberName?.trim()
  const normalizedMessageId = messageId?.trim()
  const normalizedSender = from.trim()
  const canExplainMcpReply =
    replyProtocol === 'agent_teams_message_send' &&
    isUserMessage &&
    Boolean(normalizedTeamName) &&
    Boolean(normalizedMemberName) &&
    Boolean(normalizedMessageId)
  const canExplainMcpTeamReply =
    replyProtocol === 'agent_teams_message_send' &&
    !isUserMessage &&
    Boolean(normalizedTeamName) &&
    Boolean(normalizedMemberName) &&
    Boolean(normalizedSender)
  const codexMcpToolHints = canExplainMcpReply || canExplainMcpTeamReply

  return [
    'Process this queued mailbox message now.',
    `Sender: "${from}".`,
    `Timestamp: "${timestamp}".`,
    source === 'system_notification'
      ? 'This is a system notification, not a human direct message. Process its instructions; no direct reply to the initiating user is required.'
      : isUserMessage
      ? canExplainMcpReply
        ? `If this is a human direct message, reply via agent-teams_message_send or mcp__agent-teams__message_send with teamName="${normalizedTeamName}", to="user", from="${normalizedMemberName}", text, summary, source="runtime_delivery", and relayOfMessageId="${normalizedMessageId}". Do not use SendMessage for this Codex-native handoff. If neither MCP tool name is available before any visible-message tool attempt, write exactly the concise reply text as normal assistant text so the runtime can relay it. This handoff delivery rule supersedes older SendMessage-only wording inside queued_mailbox_message.`
        : 'If this is a human direct message, reply via SendMessage with to="user", summary, and message. If SendMessage is unavailable or fails, write exactly the concise reply text as normal assistant text so the runtime can relay it.'
      : canExplainMcpTeamReply
        ? `If this message requires a visible reply, reply via agent-teams_message_send or mcp__agent-teams__message_send with teamName="${normalizedTeamName}", to="${normalizedSender}", from="${normalizedMemberName}", text, summary, and source="runtime_delivery". Do not use SendMessage for this Codex-native handoff.`
        : 'If this message requires a reply, use SendMessage to the sender.',
    ...(codexMcpToolHints ? [CODEX_AGENT_TEAMS_MCP_TOOL_HINT] : []),
    '',
    '<queued_mailbox_message>',
    text,
    '</queued_mailbox_message>',
  ].join('\n')
}

function isPrefixedAgentTeamsMessageSendToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return (
    normalized === 'agent-teams_message_send' ||
    normalized === 'agent_teams_message_send' ||
    normalized === 'mcp__agent-teams__message_send' ||
    normalized === 'mcp__agent_teams__message_send'
  )
}

function hasMatchingAgentTeamsMessageSendTeamName(
  input: { teamName?: unknown },
  expectedTeamName?: string,
): boolean {
  if (!expectedTeamName?.trim()) {
    return false
  }
  return (
    typeof input.teamName === 'string' &&
    input.teamName.trim() === expectedTeamName.trim()
  )
}

function hasConflictingAgentTeamsMessageSendTeamName(
  input: { teamName?: unknown },
  expectedTeamName?: string,
): boolean {
  return (
    Boolean(expectedTeamName?.trim()) &&
    typeof input.teamName === 'string' &&
    input.teamName.trim() !== expectedTeamName?.trim()
  )
}

function isUserReplyToolUse(
  block: unknown,
  expectedTeamName?: string,
): block is {
  id: string
  input: { to: string; teamName?: unknown }
  name: string
  type: 'tool_use'
} {
  if (
    typeof block !== 'object' ||
    block == null ||
    !('type' in block) ||
    block.type !== 'tool_use' ||
    !('id' in block) ||
    typeof block.id !== 'string' ||
    !('name' in block) ||
    typeof block.name !== 'string' ||
    !('input' in block) ||
    typeof block.input !== 'object' ||
    block.input == null ||
    !('to' in block.input) ||
    typeof block.input.to !== 'string'
  ) {
    return false
  }

  const toolInput = block.input as { to: string; teamName?: unknown }
  if (toolInput.to.trim().toLowerCase() !== 'user') {
    return false
  }

  const hasPrefixedAgentTeamsName = isPrefixedAgentTeamsMessageSendToolName(
    block.name,
  )
  if (
    hasPrefixedAgentTeamsName &&
    hasConflictingAgentTeamsMessageSendTeamName(toolInput, expectedTeamName)
  ) {
    return false
  }

  return (
    block.name === SEND_MESSAGE_TOOL_NAME ||
    hasPrefixedAgentTeamsName ||
    (block.name.trim().toLowerCase() === 'message_send' &&
      hasMatchingAgentTeamsMessageSendTeamName(toolInput, expectedTeamName))
  )
}

export function extractTaskRefFromMailboxText(text: string): string | undefined {
  const taskIdMatch = text.match(
    /["']?\btaskId\b["']?\s*[:=]\s*["']?([a-zA-Z0-9][a-zA-Z0-9_-]{5,})["']?/,
  )
  if (taskIdMatch?.[1]) {
    return taskIdMatch[1]
  }

  const hashTaskMatch = text.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{5,})/)
  return hashTaskMatch?.[1]
}

function formatTaskRefForHuman(taskRef?: string): string {
  if (!taskRef) {
    return 'unknown task'
  }
  return taskRef.startsWith('#') ? taskRef : `#${taskRef}`
}

export function getOrdinaryRecoveryInlineHandoffPrompt({
  from,
  text,
  timestamp,
  failureDetail,
  taskRef,
}: {
  from: string
  text: string
  timestamp: string
  failureDetail: string
  taskRef?: string
}): string {
  return [
    'Process this queued mailbox message now.',
    'Recovery mode after a Codex native mailbox timeout.',
    `Sender: "${from}".`,
    `Timestamp: "${timestamp}".`,
    `Task reference: ${taskRef ? formatTaskRefForHuman(taskRef) : 'not found in mailbox text'}.`,
    `Previous turn failure: ${failureDetail}`,
    '',
    'Do not restart from scratch.',
    'First inspect the current task state, transcript, and working tree diff before doing more work.',
    'If the task is already started, leave a task comment saying you are recovering after a Codex native timeout before continuing.',
    'Complete only the missing work. If the current state is unclear, send a concise durable message to team-lead instead of guessing.',
    '',
    '<queued_mailbox_message>',
    text,
    '</queued_mailbox_message>',
  ].join('\n')
}

export function buildCodexNativeMailboxTimeoutLeadNotificationText({
  memberName,
  taskRef,
  detail,
  final,
}: {
  memberName: string
  taskRef?: string
  detail: string
  final: boolean
}): string {
  if (final) {
    return buildAgentErrorNotificationText({
      memberName,
      taskRef,
      detail,
      action: 'could not recover a Codex native mailbox turn after timeout',
      consequence: 'Marking the mailbox row processed to avoid an infinite loop',
    })
  }
  return buildAgentErrorNotificationText({
    memberName,
    taskRef,
    detail,
    action: 'hit a Codex native mailbox timeout',
    consequence:
      'Scheduling one recovery turn that will inspect state before continuing',
  })
}

export function buildAgentErrorNotificationText({
  memberName,
  taskRef,
  detail,
  action,
  consequence,
}: {
  memberName: string
  taskRef?: string
  detail: string
  action: string
  consequence?: string
}): string {
  const taskText = taskRef
    ? ` for ${formatTaskRefForHuman(taskRef)}`
    : ''
  const consequenceText = consequence ? ` ${consequence}.` : ''
  return `${memberName} ${action}${taskText}.${consequenceText} API Error: ${detail}`
}

export function buildMailboxExecutionFailureLeadNotificationText({
  memberName,
  taskRef,
  detail,
}: {
  memberName: string
  taskRef?: string
  detail: string
}): string {
  return buildAgentErrorNotificationText({
    memberName,
    taskRef,
    detail,
    action: 'hit a mailbox turn execution error',
    consequence: 'Marking the mailbox row processed to avoid an infinite loop',
  })
}

export function buildOrdinaryAgentErrorMetadata(input: {
  reason: 'execution_failed' | 'timeout_recovery_failed'
  detail: string
  failedMessageId: string
  runtimeSessionId: string
  bootstrapRunId?: string
  innerRecoveryAttempts: number
}): NonNullable<TeammateMessage['agentError']> {
  return {
    schemaVersion: 1,
    type:
      input.reason === 'execution_failed'
        ? 'api_error'
        : 'codex_native_timeout',
    phase: 'terminal',
    detail: input.detail,
    failedMessageId: input.failedMessageId,
    runtimeSessionId: input.runtimeSessionId,
    ...(input.bootstrapRunId ? { bootstrapRunId: input.bootstrapRunId } : {}),
    innerRecoveryAttempts: input.innerRecoveryAttempts,
  }
}

async function writeAgentErrorLeadNotification({
  agentName,
  agentError,
  teamName,
  text,
  summary,
}: {
  agentName: string
  agentError?: TeammateMessage['agentError']
  teamName?: string
  text: string
  summary: string
}): Promise<void> {
  const timestamp = new Date().toISOString()
  try {
    await writeToMailbox(
      TEAM_LEAD_NAME,
      {
        messageId: `agent-error-${randomUUID()}`,
        from: agentName,
        text,
        summary,
        timestamp,
        color: getTeammateColor(),
        messageKind: 'agent_error' as const,
        ...(agentError ? { agentError } : {}),
      },
      teamName,
    )
  } catch (error) {
    logForDebugging(
      `[InboxPoller] Failed to notify team-lead about agent error: ${String(error)}`,
    )
  }
}

type BootstrapAttemptOutcome = 'member_briefing' | 'team_lead_fallback' | 'none'
type OrdinaryAttemptOutcome = 'user_send_message' | 'none'
type MemberWorkSyncNudgeOutcome = 'report' | 'status' | 'pending_tool' | 'none'
type OrdinaryDirectReplyFallback = {
  text: string
}
type OrdinaryAttemptExecutionError = {
  type: 'api_error' | 'codex_native_timeout'
  detail: string
}
type BootstrapAttemptExecutionError = OrdinaryAttemptExecutionError
type BootstrapToolDescriptor = Pick<
  Tool,
  'alwaysLoad' | 'isMcp' | 'name' | 'shouldDefer'
>
type BootstrapReadinessDecision =
  | { type: 'wait'; remainingMs: number }
  | { type: 'proceed' }

function findBootstrapMemberBriefingTool(
  tools: readonly BootstrapToolDescriptor[],
): BootstrapToolDescriptor | undefined {
  return tools.find(tool => isMemberBriefingToolName(tool.name))
}

function isDeferredBootstrapTool(tool: BootstrapToolDescriptor): boolean {
  if (tool.alwaysLoad === true) {
    return false
  }
  return tool.isMcp === true || tool.shouldDefer === true
}

export function isBootstrapMemberBriefingCallableNow({
  toolSearchEnabledOptimistic,
  tools,
}: {
  toolSearchEnabledOptimistic: boolean
  tools: readonly BootstrapToolDescriptor[]
}): boolean {
  const tool = findBootstrapMemberBriefingTool(tools)
  if (!tool) {
    return false
  }

  if (!toolSearchEnabledOptimistic) {
    return true
  }

  return !isDeferredBootstrapTool(tool)
}

export function getBootstrapReadinessDecision({
  now,
  toolCallableNow,
  graceMs = BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS,
  waitStartedAt,
}: {
  now: number
  toolCallableNow: boolean
  graceMs?: number
  waitStartedAt?: number
}): BootstrapReadinessDecision {
  if (toolCallableNow) {
    return { type: 'proceed' }
  }

  const startedAt = waitStartedAt ?? now
  const elapsedMs = now - startedAt
  if (elapsedMs >= graceMs) {
    return { type: 'proceed' }
  }

  return {
    type: 'wait',
    remainingMs: Math.max(1, graceMs - elapsedMs),
  }
}

export function getBootstrapTranscriptActivitySignature(
  messages: AppState['messages'],
): string {
  const lastMessage = messages.at(-1)
  return `${messages.length}:${lastMessage?.uuid ?? ''}:${lastMessage?.type ?? ''}`
}

function isToolResultUserMessage(message: AppState['messages'][number]): boolean {
  return (
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_result')
  )
}

function hasAttemptObservedPostSubmitActivity({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): boolean {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return false
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        return true
      }
      break
    }

    if (message.type === 'assistant') {
      return true
    }
  }

  return false
}

export function findBootstrapAttemptOutcome({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): BootstrapAttemptOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return 'none'
  }

  const pendingMemberBriefingToolUseIds = new Set<string>()
  const pendingTeamLeadFallbackToolUseIds = new Set<string>()

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        for (const block of message.message.content) {
          if (
            block.type === 'tool_result' &&
            pendingMemberBriefingToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'member_briefing'
          }
          if (
            block.type === 'tool_result' &&
            pendingTeamLeadFallbackToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'team_lead_fallback'
          }
        }
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    for (const block of message.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (isMemberBriefingToolName(block.name)) {
        pendingMemberBriefingToolUseIds.add(block.id)
        continue
      }
      if (
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to.toLowerCase() === TEAM_LEAD_NAME.toLowerCase()
      ) {
        pendingTeamLeadFallbackToolUseIds.add(block.id)
      }
    }
  }

  return 'none'
}

type NativeAppManagedBootstrapAttemptOutcome =
  | { type: 'confirmed' }
  | { type: 'fatal'; detail: string }
  | { type: 'none' }

function normalizeAssistantText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isUsableNativeAppManagedBootstrapText(text: string): boolean {
  const normalized = normalizeAssistantText(text).toLowerCase()
  return (
    normalized.length > 0 &&
    normalized !== '(no content)' &&
    normalized !== 'no response requested.' &&
    getNativeAppManagedBootstrapFatalText(text) == null
  )
}

function getNativeAppManagedBootstrapFatalText(text: string): string | null {
  const trimmed = text.trim()
  const normalized = normalizeAssistantText(trimmed).toLowerCase()
  if (!normalized) {
    return null
  }
  const terminalPrefixes = [
    'api error',
    'apierror',
    'token refresh failed',
    'unauthorized',
    'authentication_error',
    'invalid authentication',
    'forbidden',
  ]
  return terminalPrefixes.some(prefix => normalized.startsWith(prefix))
    ? trimmed
    : null
}

export function findNativeAppManagedBootstrapAttemptOutcome({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): NativeAppManagedBootstrapAttemptOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return { type: 'none' }
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }
    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }
    if (message.type !== 'assistant') {
      continue
    }
    if (message.isApiErrorMessage === true) {
      const errorDetails =
        'errorDetails' in message && typeof message.errorDetails === 'string'
          ? message.errorDetails
          : undefined
      const text = extractAssistantText(message)
      return { type: 'fatal', detail: errorDetails || text || 'API error' }
    }

    const textParts: string[] = []
    for (const block of message.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      }
    }
    const text = textParts.join('\n\n')
    if (isUsableNativeAppManagedBootstrapText(text)) {
      return { type: 'confirmed' }
    }
    const fatalText = getNativeAppManagedBootstrapFatalText(text)
    if (fatalText) {
      return { type: 'fatal', detail: fatalText }
    }
  }

  return { type: 'none' }
}

export function findOrdinaryDirectReplyOutcome({
  messages,
  submitUserMessageUuid,
  teamName,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
  teamName?: string
}): OrdinaryAttemptOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return 'none'
  }

  const pendingUserReplyToolUseIds = new Set<string>()

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        for (const block of message.message.content) {
          if (
            block.type === 'tool_result' &&
            pendingUserReplyToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'user_send_message'
          }
        }
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    for (const block of message.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (isUserReplyToolUse(block, teamName)) {
        pendingUserReplyToolUseIds.add(block.id)
      }
    }
  }

  return 'none'
}

function extractAssistantText(message: AppState['messages'][number], excludeEmptyMessages = false): string {
  if (message.type !== 'assistant') {
    return ''
  }

  return message.message.content
    .flatMap(block => {
      if (block.type !== 'text') {
        return []
      }
      return typeof block.text === 'string' && (!excludeEmptyMessages || !isEmptyMessageText(block.text)) ? [block.text.trim()] : []
    })
    .filter(Boolean)
    .join('\n\n')
}

function isCodexNativeExecTimeoutText(text: string): boolean {
  return text.toLowerCase().includes(CODEX_NATIVE_EXEC_TIMEOUT_ERROR_TEXT)
}

export function findOrdinaryAttemptExecutionError({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): OrdinaryAttemptExecutionError | null {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return null
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    if (message.isApiErrorMessage !== true) {
      continue
    }

    const text = extractAssistantText(message)
    const errorDetails =
      'errorDetails' in message && typeof message.errorDetails === 'string'
        ? message.errorDetails
        : undefined
    const detail = errorDetails || text

    if (detail && isCodexNativeExecTimeoutText(detail)) {
      return {
        type: 'codex_native_timeout',
        detail,
      }
    }

    if (detail) {
      return {
        type: 'api_error',
        detail,
      }
    }
  }

  return null
}

export function findBootstrapAttemptExecutionError({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): BootstrapAttemptExecutionError | null {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return null
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }

    if (message.type !== 'assistant' || message.isApiErrorMessage !== true) {
      continue
    }

    const text = extractAssistantText(message)
    const errorDetails =
      'errorDetails' in message && typeof message.errorDetails === 'string'
        ? message.errorDetails
        : undefined
    const detail = errorDetails || text

    if (detail && isCodexNativeExecTimeoutText(detail)) {
      return {
        type: 'codex_native_timeout',
        detail,
      }
    }

    if (detail) {
      return {
        type: 'api_error',
        detail,
      }
    }
  }

  return null
}

function isFatalBootstrapAttemptExecutionError(
  error: BootstrapAttemptExecutionError,
): boolean {
  if (error.type === 'codex_native_timeout') {
    return true
  }

  const detail = error.detail.toLowerCase()
  return (
    detail.includes('401') ||
    detail.includes('403') ||
    detail.includes('authentication_error') ||
    detail.includes('invalid authentication') ||
    detail.includes('please run /login') ||
    detail.includes('unauthorized') ||
    detail.includes('forbidden')
  )
}

function isAgentTeamsMemberWorkSyncToolName(
  name: string,
  action: 'report' | 'status',
): boolean {
  const normalized = name.trim().toLowerCase()
  const suffix = `member_work_sync_${action}`
  return (
    normalized === suffix ||
    normalized === `agent-teams_${suffix}` ||
    normalized === `agent_teams_${suffix}` ||
    normalized === `mcp__agent-teams__${suffix}` ||
    normalized === `mcp__agent_teams__${suffix}`
  )
}

function getToolResultText(block: { content?: unknown }): string {
  const content = block.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .flatMap(item => {
      if (
        item &&
        typeof item === 'object' &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        return [item.text]
      }
      return []
    })
    .join('\n')
}

function tryParseToolResultObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseEmbeddedToolResultObject(text: string): Record<string, unknown> | null {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let firstParsed: Record<string, unknown> | null = null

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') {
      continue
    }

    depth -= 1
    if (depth === 0) {
      const parsed = tryParseToolResultObject(text.slice(start, index + 1))
      if (parsed) {
        if (typeof parsed.accepted === 'boolean') {
          return parsed
        }
        firstParsed ??= parsed
      }
      start = -1
    }
  }

  return firstParsed
}

function parseToolResultObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return tryParseToolResultObject(trimmed) ?? parseEmbeddedToolResultObject(trimmed)
}

function collectAcceptedFlagsFromToolResultText(text: string): boolean[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  const exact = tryParseToolResultObject(trimmed)
  if (exact) {
    return collectAcceptedFlagsFromToolResultContent(exact)
  }

  const flags: boolean[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') {
      continue
    }

    depth -= 1
    if (depth === 0) {
      const parsed = tryParseToolResultObject(text.slice(start, index + 1))
      if (parsed) {
        collectAcceptedFlagsFromToolResultContent(parsed, flags)
      }
      start = -1
    }
  }

  return flags
}

function collectAcceptedFlagsFromToolResultContent(
  content: unknown,
  flags: boolean[] = [],
): boolean[] {
  if (typeof content === 'string') {
    flags.push(...collectAcceptedFlagsFromToolResultText(content))
    if (isRejectedMemberWorkSyncReportText(content)) {
      flags.push(false)
    }
    return flags
  }

  if (Array.isArray(content)) {
    content.forEach(item => collectAcceptedFlagsFromToolResultContent(item, flags))
    return flags
  }

  if (!content || typeof content !== 'object') {
    return flags
  }

  const record = content as Record<string, unknown>
  if (typeof record.accepted === 'boolean') {
    flags.push(record.accepted)
  }

  for (const key of ['content', 'text', 'result', 'output', 'data'] as const) {
    if (key in record) {
      collectAcceptedFlagsFromToolResultContent(record[key], flags)
    }
  }

  return flags
}

function getAcceptedFlagFromToolResultContent(content: unknown): boolean | null {
  const flags = collectAcceptedFlagsFromToolResultContent(content)
  if (flags.includes(false)) {
    return false
  }
  if (flags.includes(true)) {
    return true
  }
  return null
}

function isRejectedMemberWorkSyncReportText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  return (
    /\baccepted\s*[:=]\s*false\b/.test(normalized) ||
    /"accepted"\s*:\s*false/.test(normalized) ||
    /\bnot\s+accepted\b/.test(normalized) ||
    /\breport\s+rejected\b/.test(normalized) ||
    /\breport\s+(?:was\s+)?(?:not\s+accepted|failed)\b/.test(normalized) ||
    /\bmember_work_sync_report\s+(?:not\s+accepted|rejected|failed)\b/.test(normalized) ||
    /\breport_rejected(?::|_|\b)/.test(normalized) ||
    /\bstale[_\s-]+(?:agenda[_\s-]+)?fingerprint\b/.test(normalized) ||
    /\binvalid[_\s-]+report[_\s-]+token\b/.test(normalized) ||
    /\breport[_\s-]+token[_\s-]+invalid\b/.test(normalized) ||
    /\bidentity[_\s-]+(?:untrusted|mismatch)\b/.test(normalized) ||
    /\bmember[_\s-]+inactive\b/.test(normalized) ||
    /\breserved[_\s-]+or[_\s-]+invalid[_\s-]+member\b/.test(normalized) ||
    /\bteam[_\s-]+runtime[_\s-]+inactive\b/.test(normalized) ||
    /\bforeign[_\s-]+task[_\s-]+id\b/.test(normalized) ||
    /\bcaught[_\s-]+up[_\s-]+rejected[_\s-]+actionable[_\s-]+items[_\s-]+exist\b/.test(normalized) ||
    /\bstill[_\s-]+working[_\s-]+rejected[_\s-]+agenda[_\s-]+empty\b/.test(normalized) ||
    /\bblocked[_\s-]+without[_\s-]+evidence\b/.test(normalized) ||
    /\breport fingerprint is stale\b/.test(normalized) ||
    /\breport token is (?:invalid|required)\b/.test(normalized) ||
    /\bcannot report caught_up while actionable work remains\b/.test(normalized) ||
    /\bcannot report still_working when no actionable work remains\b/.test(normalized)
  )
}

function isAcceptedMemberWorkSyncReportText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  return (
    /\baccepted\s*[:=]\s*true\b/.test(normalized) ||
    /"accepted"\s*:\s*true/.test(normalized) ||
    /\breport\s+(?:was\s+)?accepted\b/.test(normalized) ||
    /\bmember_work_sync_report\s+(?:was\s+)?accepted\b/.test(normalized)
  )
}

function isAcceptedMemberWorkSyncReportToolResult(block: {
  content?: unknown
  is_error?: boolean
}): boolean {
  if (block.is_error === true) {
    return false
  }
  const acceptedFlag = getAcceptedFlagFromToolResultContent(block.content)
  if (acceptedFlag !== null) {
    return acceptedFlag
  }
  const text = getToolResultText(block)
  const parsed = parseToolResultObject(text)
  if (parsed && typeof parsed.accepted === 'boolean') {
    return parsed.accepted
  }
  if (isRejectedMemberWorkSyncReportText(text)) {
    return false
  }
  return isAcceptedMemberWorkSyncReportText(text)
}

export function findMemberWorkSyncNudgeOutcome({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): MemberWorkSyncNudgeOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return 'none'
  }

  const pendingReportToolUseIds = new Set<string>()
  const pendingStatusToolUseIds = new Set<string>()
  let sawSuccessfulStatus = false

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') {
            continue
          }
          if (pendingReportToolUseIds.has(block.tool_use_id)) {
            pendingReportToolUseIds.delete(block.tool_use_id)
            if (
              block.is_error !== true &&
              isAcceptedMemberWorkSyncReportToolResult(block)
            ) {
              return 'report'
            }
          }
          if (pendingStatusToolUseIds.has(block.tool_use_id)) {
            pendingStatusToolUseIds.delete(block.tool_use_id)
            if (block.is_error !== true) {
              sawSuccessfulStatus = true
            }
          }
        }
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    for (const block of message.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (isAgentTeamsMemberWorkSyncToolName(block.name, 'report')) {
        pendingReportToolUseIds.add(block.id)
        continue
      }
      if (isAgentTeamsMemberWorkSyncToolName(block.name, 'status')) {
        pendingStatusToolUseIds.add(block.id)
      }
    }
  }

  if (pendingReportToolUseIds.size > 0 || pendingStatusToolUseIds.size > 0) {
    return 'pending_tool'
  }
  return sawSuccessfulStatus ? 'status' : 'none'
}

export function findOrdinaryDirectReplyFallback({
  messages,
  submitUserMessageUuid,
  teamName,
  excludeEmptyMessages = false,
  excludeNativeCommentary = false,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
  teamName?: string
  excludeEmptyMessages?: boolean
  excludeNativeCommentary?: boolean
}): OrdinaryDirectReplyFallback | null {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return null
  }

  const assistantTextParts: string[] = []
  let sawUserSendMessageAttempt = false

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    const phase = (message.message as { codexNativeMessagePhase?: string }).codexNativeMessagePhase
    const text = excludeNativeCommentary && phase === 'commentary' ? '' : extractAssistantText(message, excludeEmptyMessages)
    if (text) {
      assistantTextParts.push(text)
    }

    for (const block of message.message.content) {
      if (isUserReplyToolUse(block, teamName)) {
        sawUserSendMessageAttempt = true
      }
    }
  }

  if (sawUserSendMessageAttempt || assistantTextParts.length === 0) {
    return null
  }

  return { text: assistantTextParts.join('\n\n') }
}

function getInboxReplySummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return 'teammate reply'
  }
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
}

type BootstrapAttemptState = {
  submitUserMessageUuid: string
  submittedAt: number
  cooldownUntil: number
  status: 'in_flight' | 'cooling_down'
  timer: ReturnType<typeof setTimeout> | null
  nativeAppManaged?: {
    contextHash: string
    briefingHash: string
    bootstrapProofToken: string
    runId: string
  }
}
type BootstrapReadinessWaitState = {
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}
type OrdinaryAttemptState = {
  submitUserMessageUuid: string
  submittedAt: number
  cooldownUntil: number
  status: 'in_flight' | 'cooling_down'
  timer: ReturnType<typeof setTimeout> | null
}
type OrdinaryRecoveryState = {
  attemptCount: number
  failureDetail: string
  taskRef?: string
  notifiedLead: boolean
}

type BootstrapProcessingAction =
  | { type: 'noop' }
  | { type: 'reset_to_pending' }
  | { type: 'finalize' }
  | { type: 'schedule_cooldown' }
  | { type: 'fail'; detail: string }
type OrdinaryProcessingAction =
  | { type: 'noop' }
  | { type: 'reset_to_pending' }
  | { type: 'finalize' }
  | { type: 'schedule_cooldown'; cooldownMs?: number }
  | {
      type: 'schedule_recovery'
      detail: string
      taskRef?: string
    }
  | {
      type: 'notify_failure'
      detail: string
      reason: 'execution_failed' | 'timeout_recovery_failed'
      taskRef?: string
    }
  | { type: 'deliver_assistant_text'; text: string }

export function buildNativeAttachmentFailureMessage(
  payload: NativeAttachmentFailurePayload,
): Omit<TeammateMessage, 'read'> {
  const originalMessageId = payload.message.messageId!
  const failureId = `native-attachment-failure-${createHash('sha256')
    .update(originalMessageId)
    .digest('hex')
    .slice(0, 24)}`
  const detail = payload.reasonCode
  return {
    messageId: failureId,
    from: payload.agentName,
    text: `Native teammate attachment delivery failed for message ${originalMessageId}: ${detail}.`,
    timestamp: payload.message.timestamp,
    summary: 'Native teammate attachment failure',
    color: getTeammateColor(),
    messageKind: 'agent_error',
    nativeAttachmentFailure: {
      originalMessageId,
      reasonCode: payload.reasonCode,
    },
  }
}

export type NativeAttachmentFailureReceipt = NativeAttachmentFailurePayload & {
  failureMessage: Omit<TeammateMessage, 'read'>
}

/** Finalize the source only after immutable USER failure evidence is verified. */
export async function persistNativeAttachmentFailureReceipt(payload: NativeAttachmentFailureReceipt): Promise<void> {
  await writeToMailboxVerified('user', payload.failureMessage, payload.teamName, { immutableAttachmentFailure: true })
  await finalizeClaimedMessagesAsRead(payload.agentName, [payload.message.messageId!], payload.sessionId, payload.teamName)
}

/** A deterministic mailbox identity makes a completed local fallback replay-safe. */
export async function relayOrdinaryMailboxAssistantText(input: {
  message: Pick<PendingInboxMirrorMessage, 'messageId' | 'timestamp'>
  agentName: string
  teamName?: string
  text: string
}): Promise<void> {
  if (!input.message.messageId) throw new Error('Mailbox reply requires its source message identity')
  const messageId = `mailbox-assistant-reply-${createHash('sha256').update(input.message.messageId).digest('hex').slice(0, 24)}`
  await writeToMailboxVerified('user', {
    messageId,
    from: input.agentName,
    text: input.text,
    summary: getInboxReplySummary(input.text),
    timestamp: input.message.timestamp,
    color: getTeammateColor(),
  }, input.teamName)
}

export function getBootstrapProcessingAction({
  attempt,
  messages,
  processingBootstrapMessage,
}: {
  attempt?: BootstrapAttemptState
  messages: AppState['messages']
  processingBootstrapMessage?: PendingInboxMirrorMessage
}): BootstrapProcessingAction {
  if (!processingBootstrapMessage?.messageId) {
    return { type: 'noop' }
  }

  if (!attempt) {
    return { type: 'reset_to_pending' }
  }

  if (attempt.nativeAppManaged) {
    const nativeOutcome = findNativeAppManagedBootstrapAttemptOutcome({
      messages,
      submitUserMessageUuid: attempt.submitUserMessageUuid,
    })
    if (nativeOutcome.type === 'confirmed') {
      return { type: 'finalize' }
    }
    if (nativeOutcome.type === 'fatal') {
      return { type: 'fail', detail: nativeOutcome.detail }
    }
    const executionError = findBootstrapAttemptExecutionError({
      messages,
      submitUserMessageUuid: attempt.submitUserMessageUuid,
    })
    if (
      executionError &&
      isFatalBootstrapAttemptExecutionError(executionError)
    ) {
      return { type: 'fail', detail: executionError.detail }
    }

    if (attempt.status === 'in_flight') {
      if (
        !hasAttemptObservedPostSubmitActivity({
          messages,
          submitUserMessageUuid: attempt.submitUserMessageUuid,
        })
      ) {
        return { type: 'noop' }
      }
      return { type: 'schedule_cooldown' }
    }

    return { type: 'noop' }
  }

  const outcome = findBootstrapAttemptOutcome({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })

  if (outcome !== 'none') {
    return { type: 'finalize' }
  }

  const executionError = findBootstrapAttemptExecutionError({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  if (executionError) {
    if (isFatalBootstrapAttemptExecutionError(executionError)) {
      return { type: 'fail', detail: executionError.detail }
    }
  }

  if (attempt.status === 'in_flight') {
    // A newly submitted bootstrap row enters "processing" immediately after
    // handleIncomingPrompt() accepts it. Do not start the retry cooldown until
    // the submitted turn has produced some post-submit transcript activity,
    // otherwise we can race ahead of the first member_briefing response and
    // strand the row in processing.
    if (
      !hasAttemptObservedPostSubmitActivity({
        messages,
        submitUserMessageUuid: attempt.submitUserMessageUuid,
      })
    ) {
      return { type: 'noop' }
    }
    return { type: 'schedule_cooldown' }
  }

  return { type: 'noop' }
}

export function getOrdinaryProcessingAction({
  attempt,
  messages,
  now = Date.now(),
  processingOrdinaryMessage,
  recoveryAttemptCount = 0,
  teamName,
  memberName = getAgentName(),
}: {
  attempt?: OrdinaryAttemptState
  messages: AppState['messages']
  now?: number
  processingOrdinaryMessage?: PendingInboxMirrorMessage
  recoveryAttemptCount?: number
  teamName?: string
  memberName?: string
}): OrdinaryProcessingAction {
  if (!processingOrdinaryMessage?.messageId) {
    return { type: 'noop' }
  }

  if (!attempt) {
    return { type: 'reset_to_pending' }
  }

  if (hasGroupMailboxMarker(processingOrdinaryMessage)) {
    const groupOutcome = findGroupMailboxReplyOutcome({
      messages, submitUserMessageUuid: attempt.submitUserMessageUuid, teamName,
      groupChatId: processingOrdinaryMessage.groupChatId!,
      physicalMessageId: processingOrdinaryMessage.messageId,
      canonicalMessageId: processingOrdinaryMessage.groupMessageId,
      groupRunKey: processingOrdinaryMessage.groupRunKey,
      memberName,
    })
    if (groupOutcome === 'sent' || groupOutcome === 'acknowledged' || groupOutcome === 'blocked') return { type: 'finalize' }
    if (groupOutcome === 'pending') return { type: 'noop' }
    if (hasConflictingGroupReplyScope({ messages, submitUserMessageUuid: attempt.submitUserMessageUuid, groupChatId: processingOrdinaryMessage.groupChatId!, physicalMessageId: processingOrdinaryMessage.messageId, teamName, memberName })) {
      logForDebugging('[InboxPoller] Ambiguous group turn: no inferred reply destination or private fallback')
      return { type: 'finalize' }
    }
    const fallback = findOrdinaryDirectReplyFallback({ messages, submitUserMessageUuid: attempt.submitUserMessageUuid, teamName, excludeEmptyMessages: true, excludeNativeCommentary: true })
    if (fallback) return { type: 'deliver_assistant_text', text: fallback.text }
    if (hasAttemptObservedPostSubmitActivity({ messages, submitUserMessageUuid: attempt.submitUserMessageUuid })) return { type: 'finalize' }
    return { type: 'noop' }
  }

  const outcome = findOrdinaryDirectReplyOutcome({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
    ...(teamName ? { teamName } : {}),
  })
  const executionError = findOrdinaryAttemptExecutionError({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  const observedPostSubmitActivity = hasAttemptObservedPostSubmitActivity({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  const requiresUserReply =
    isHumanDirectMailboxMessage(processingOrdinaryMessage)
  const requiresWorkSyncReport =
    processingOrdinaryMessage.messageKind === 'member_work_sync_nudge'
  const workSyncOutcome = requiresWorkSyncReport
    ? findMemberWorkSyncNudgeOutcome({
        messages,
        submitUserMessageUuid: attempt.submitUserMessageUuid,
      })
    : 'none'

  if (requiresWorkSyncReport) {
    if (workSyncOutcome === 'report') {
      return { type: 'finalize' }
    }
  }

  if (!requiresWorkSyncReport && outcome === 'user_send_message') {
    return { type: 'finalize' }
  }

  if (
    requiresWorkSyncReport &&
    attempt.status === 'in_flight' &&
    executionError
  ) {
    return {
      type: 'schedule_cooldown',
      cooldownMs: MEMBER_WORK_SYNC_NUDGE_RETRY_COOLDOWN_MS,
    }
  }

  if (
    requiresWorkSyncReport &&
    attempt.status === 'in_flight' &&
    workSyncOutcome === 'pending_tool'
  ) {
    if (now - attempt.submittedAt < MEMBER_WORK_SYNC_NUDGE_IN_FLIGHT_STALL_MS) {
      return { type: 'noop' }
    }
    return {
      type: 'schedule_cooldown',
      cooldownMs: MEMBER_WORK_SYNC_NUDGE_RETRY_COOLDOWN_MS,
    }
  }

  if (
    requiresWorkSyncReport &&
    attempt.status === 'in_flight' &&
    !observedPostSubmitActivity &&
    now - attempt.submittedAt >= MEMBER_WORK_SYNC_NUDGE_IN_FLIGHT_STALL_MS
  ) {
    return {
      type: 'schedule_cooldown',
      cooldownMs: MEMBER_WORK_SYNC_NUDGE_RETRY_COOLDOWN_MS,
    }
  }

  if (
    attempt.status === 'in_flight' &&
    (executionError?.type === 'codex_native_timeout' ||
      (executionError && isNativeAttachmentMailboxMessage(processingOrdinaryMessage)))
  ) {
    const taskRef = extractTaskRefFromMailboxText(processingOrdinaryMessage.text)
    if (
      recoveryAttemptCount <
        ORDINARY_DIRECT_MESSAGE_MAX_AUTO_RECOVERY_ATTEMPTS
    ) {
      return {
        type: 'schedule_recovery',
        detail: executionError.detail,
        taskRef,
      }
    }
    return {
      type: 'notify_failure',
      detail: executionError.detail,
      reason: 'timeout_recovery_failed',
      taskRef,
    }
  }

  if (
    attempt.status === 'in_flight' &&
    executionError &&
    recoveryAttemptCount > 0
  ) {
    return {
      type: 'notify_failure',
      detail: executionError.detail,
      reason: 'timeout_recovery_failed',
      taskRef: extractTaskRefFromMailboxText(processingOrdinaryMessage.text),
    }
  }

  if (
    attempt.status === 'in_flight' &&
    executionError &&
    !requiresUserReply
  ) {
    return {
      type: 'notify_failure',
      detail: executionError.detail,
      reason: 'execution_failed',
      taskRef: extractTaskRefFromMailboxText(processingOrdinaryMessage.text),
    }
  }

  if (attempt.status === 'cooling_down' && executionError) {
    return { type: 'noop' }
  }

  if (
    !requiresWorkSyncReport &&
    attempt.status === 'in_flight' &&
    !observedPostSubmitActivity &&
    now - attempt.submittedAt >= ORDINARY_DIRECT_MESSAGE_IN_FLIGHT_STALL_MS
  ) {
    return {
      type: 'schedule_cooldown',
      cooldownMs: ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS,
    }
  }

  if (!requiresUserReply && !requiresWorkSyncReport && observedPostSubmitActivity) {
    return { type: 'finalize' }
  }

  if (requiresUserReply) {
    const fallback = findOrdinaryDirectReplyFallback({
      messages,
      submitUserMessageUuid: attempt.submitUserMessageUuid,
      excludeEmptyMessages: true,
      ...(teamName ? { teamName } : {}),
    })
    if (fallback) {
      return { type: 'deliver_assistant_text', text: fallback.text }
    }
  }

  if (attempt.status === 'in_flight') {
    // Accepted means the handoff prompt entered the REPL. It does not mean
    // the teammate replied through SendMessage, so wait for transcript activity
    // before retrying instead of marking the mailbox row as read immediately.
    if (!observedPostSubmitActivity) {
      return { type: 'noop' }
    }
    return {
      type: 'schedule_cooldown',
      ...(requiresWorkSyncReport
        ? { cooldownMs: MEMBER_WORK_SYNC_NUDGE_RETRY_COOLDOWN_MS }
        : {}),
    }
  }

  return { type: 'noop' }
}

/**
 * Polls the teammate inbox for new messages and submits them as turns.
 *
 * This hook:
 * 1. Polls every 1s for unread messages (teammates or team leads)
 * 2. When idle: submits messages immediately as a new turn
 * 3. When busy: queues messages in AppState.inbox for UI display, delivers when turn ends
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  getMessages,
  transcriptActivitySignature,
  runtimeInstanceId,
  onSubmitMessage,
  getNativeAppManagedBootstrapContextInjection,
  onAgentErrorNotification,
  onBootstrapConfirmed,
  onNativeInboxAttachmentsReady,
  isIncomingPromptIdle,
}: Props): void {
  // Assign to original name for clarity within the function
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxStateSignature = useAppState(s =>
    s.inbox.messages.map(message => `${message.id}:${message.status}`).join('|'),
  )
  const mcpToolSignature = useAppState(s =>
    s.mcp.tools
      .map(tool => `${tool.name}:${tool.alwaysLoad === true ? '1' : '0'}`)
      .sort()
      .join('|'),
  )
  const terminal = useTerminalNotification()
  const pollInFlightRef = useRef(false)
  const didWriteInboxPollerReadyRef = useRef(false)
  const bootstrapAttemptsRef = useRef<Map<string, BootstrapAttemptState>>(
    new Map(),
  )
  const observedBootstrapTransportRef = useRef<Set<string>>(new Set())
  const groupHostTurnsRef = useRef<GroupMailboxHostTurn[]>([])
  const ordinaryAttemptsRef = useRef<Map<string, OrdinaryAttemptState>>(
    new Map(),
  )
  const ordinaryRecoveryRef = useRef<Map<string, OrdinaryRecoveryState>>(
    new Map(),
  )
  const ordinaryTerminalFailureRef = useRef<Set<string>>(new Set())
  const ordinaryFinalizationInFlightRef = useRef<Set<string>>(new Set())
  const nativeAttachmentPreparationInFlightRef = useRef<Set<string>>(new Set())
  const nativeAttachmentFailureWritesRef = useRef<
    Map<string, NativeAttachmentFailurePayload & { failureMessage: Omit<TeammateMessage, 'read'> }>
  >(new Map())
  const nativeAttachmentFailureWriteInFlightRef = useRef<Set<string>>(new Set())
  const bootstrapReadinessWaitsRef = useRef<
    Map<string, BootstrapReadinessWaitState>
  >(new Map())
  const [bootstrapReadinessTick, setBootstrapReadinessTick] = useState(0)
  const [idleDeliveryRetryTick, setIdleDeliveryRetryTick] = useState(0)
  const idleDeliveryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const persistNativeAttachmentFailure = useCallback(async (
    payload: NativeAttachmentFailurePayload & { failureMessage: Omit<TeammateMessage, 'read'> },
  ): Promise<void> => {
    const originalMessageId = payload.message.messageId
    if (!originalMessageId) return
    if (nativeAttachmentFailureWriteInFlightRef.current.has(originalMessageId)) {
      return
    }
    nativeAttachmentFailureWriteInFlightRef.current.add(originalMessageId)
    try {
      await persistNativeAttachmentFailureReceipt(payload)

      // Durable USER proof is the terminal boundary. Nothing below may run
      // before the stable failure row is written and verified.
      ordinaryTerminalFailureRef.current.add(originalMessageId)
      const attempt = ordinaryAttemptsRef.current.get(originalMessageId)
      if (attempt?.timer) clearTimeout(attempt.timer)
      ordinaryAttemptsRef.current.delete(originalMessageId)
      ordinaryRecoveryRef.current.delete(originalMessageId)
      const rowId = payload.message.id
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.map(message =>
            message.id === rowId
              ? { ...message, status: 'processed' as const }
              : message,
          ),
        },
      }))
      nativeAttachmentFailureWritesRef.current.delete(originalMessageId)
    } catch (error) {
      logForDebugging(
        `[InboxPoller] Native attachment USER failure write remains pending for ${originalMessageId}: ${String(error)}`,
      )
      logError(error)
      nativeAttachmentFailureWritesRef.current.set(originalMessageId, payload)
    } finally {
      nativeAttachmentFailureWriteInFlightRef.current.delete(originalMessageId)
    }
  }, [setAppState])

  const queueNativeAttachmentFailure = useCallback((
    payload: NativeAttachmentFailurePayload,
  ): void => {
    if (!payload.message.messageId) return
    const originalMessageId = payload.message.messageId
    const frozenPayload = nativeAttachmentFailureWritesRef.current.get(originalMessageId) ?? {
      ...payload,
      failureMessage: Object.freeze(buildNativeAttachmentFailureMessage(payload)),
    }
    nativeAttachmentFailureWritesRef.current.set(originalMessageId, frozenPayload)
    void persistNativeAttachmentFailure(frozenPayload)
  }, [persistNativeAttachmentFailure])

  useEffect(() => {
    return () => {
      if (idleDeliveryRetryTimerRef.current) {
        clearTimeout(idleDeliveryRetryTimerRef.current)
        idleDeliveryRetryTimerRef.current = null
      }
      for (const attempt of bootstrapAttemptsRef.current.values()) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
      }
      bootstrapAttemptsRef.current.clear()
      observedBootstrapTransportRef.current.clear()
      for (const attempt of ordinaryAttemptsRef.current.values()) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
      }
      ordinaryAttemptsRef.current.clear()
      ordinaryRecoveryRef.current.clear()
      ordinaryTerminalFailureRef.current.clear()
      nativeAttachmentPreparationInFlightRef.current.clear()
      nativeAttachmentFailureWritesRef.current.clear()
      nativeAttachmentFailureWriteInFlightRef.current.clear()
      for (const waitState of bootstrapReadinessWaitsRef.current.values()) {
        if (waitState.timer) {
          clearTimeout(waitState.timer)
        }
      }
      bootstrapReadinessWaitsRef.current.clear()
      ordinaryFinalizationInFlightRef.current.clear()
    }
  }, [])

  const poll = useCallback(async () => {
    if (!enabled) return
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true

    try {
      const currentAppState = store.getState()
      const agentName = getAgentNameToPoll(currentAppState)
      if (!agentName) return
      const teamName = currentAppState.teamContext?.teamName
      for (const payload of nativeAttachmentFailureWritesRef.current.values()) {
        if (
          payload.agentName === agentName &&
          !nativeAttachmentFailureWriteInFlightRef.current.has(
            payload.message.messageId!,
          )
        ) {
          void persistNativeAttachmentFailure(payload)
        }
      }
      if (teamName) {
        await processBoundWorkSyncContinuationAdmission()
      }
      const sessionId = getSessionId()
      const staleMirroredMessageIds = new Set(
        currentAppState.inbox.messages
          .filter(
            message => !isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
          )
          .map(message => message.id),
      )
      if (staleMirroredMessageIds.size > 0) {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.filter(
              message => !staleMirroredMessageIds.has(message.id),
            ),
          },
        }))
      }

      const mirroredMessageIds = new Set<string>(
        currentAppState.inbox.messages
          .filter(message =>
            isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
          )
          .map(message => message.messageId)
          .filter(
            (messageId): messageId is string =>
              typeof messageId === 'string' && messageId.length > 0,
          ),
      )
      const { regularClaimed: claimedRegularMessages, protocolUnread: unread } =
        await readAndClaimInteractiveMailboxSnapshot(
          agentName,
          sessionId,
          teamName,
          { excludeMessageIds: [...mirroredMessageIds] },
        )
      const staleGroupMessages = claimedRegularMessages.filter(message => !isCurrentGroupMailboxMessage(message))
      if (staleGroupMessages.length > 0) {
        await finalizeClaimedMessagesAsRead(agentName, staleGroupMessages.map(message => message.messageId), sessionId, teamName)
        logForDebugging(`[InboxPoller] Suppressed ${staleGroupMessages.length} stale or invalid group deliveries for this run`)
      }
      const currentRunClaimedRegularMessages = claimedRegularMessages.filter(message => isCurrentGroupMailboxMessage(message))
      const agentErrorNotificationMessages = currentRunClaimedRegularMessages.filter(
        isAgentErrorNotificationMessage,
      )
      const nonAgentErrorClaimedRegularMessages = currentRunClaimedRegularMessages.filter(
        message => !isAgentErrorNotificationMessage(message),
      )
      const silentlyFinalizedRegularMessages =
        nonAgentErrorClaimedRegularMessages.filter(message =>
          isSilentRegularMailboxMessageForLiveContext(message),
        )
      const terminalFailedRegularMessages =
        nonAgentErrorClaimedRegularMessages.filter(
          message =>
            !isSilentRegularMailboxMessageForLiveContext(message) &&
            ordinaryTerminalFailureRef.current.has(message.messageId),
        )
      const actionableClaimedRegularMessages =
        nonAgentErrorClaimedRegularMessages.filter(
          message =>
            !isSilentRegularMailboxMessageForLiveContext(message) &&
            !ordinaryTerminalFailureRef.current.has(message.messageId),
        )

      if (agentErrorNotificationMessages.length > 0) {
        for (const message of agentErrorNotificationMessages) {
          onAgentErrorNotification(message)
          if (!isLoading && !focusedInputDialog) {
            void sendNotification(
              {
                message: message.text,
                title: 'Agent error',
                notificationType: 'agent_error',
              },
              terminal,
            )
          }
        }
        await finalizeClaimedMessagesAsRead(
          agentName,
          agentErrorNotificationMessages.map(message => message.messageId),
          sessionId,
          teamName,
        )
        logForDebugging(
          `[InboxPoller] Displayed ${agentErrorNotificationMessages.length} agent error notification(s)`,
        )
      }

      if (silentlyFinalizedRegularMessages.length > 0) {
        await finalizeClaimedMessagesAsRead(
          agentName,
          silentlyFinalizedRegularMessages.map(message => message.messageId),
          sessionId,
          teamName,
        )
        logForDebugging(
          `[InboxPoller] Silently finalized ${silentlyFinalizedRegularMessages.length} informational regular message(s)`,
        )
      }

      if (terminalFailedRegularMessages.length > 0) {
        await finalizeClaimedMessagesAsRead(
          agentName,
          terminalFailedRegularMessages.map(message => message.messageId),
          sessionId,
          teamName,
        )
        logForDebugging(
          `[InboxPoller] Suppressed ${terminalFailedRegularMessages.length} terminally failed ordinary mailbox message(s)`,
        )
      }

      if (unread.length === 0 && actionableClaimedRegularMessages.length === 0) {
        return
      }

      logForDebugging(
        `[InboxPoller] Found ${unread.length} protocol unread message(s), ${actionableClaimedRegularMessages.length} actionable claimed regular message(s), ${silentlyFinalizedRegularMessages.length} silent regular message(s), and ${terminalFailedRegularMessages.length} terminal failed regular message(s)`,
      )


      // Separate permission messages from regular teammate messages
      const permissionRequests: TeammateMessage[] = []
      const sandboxPermissionRequests: TeammateMessage[] = []
      const shutdownRequests: TeammateMessage[] = []
      const shutdownApprovals: TeammateMessage[] = []
      const planApprovalRequests: TeammateMessage[] = []
      const protocolMessagesHandledInline: TeammateMessage[] = []
      const protocolMessagesForLiveContext: TeammateMessage[] = []

      for (const m of unread) {
        if (isRegularInteractiveMailboxMessage(m)) {
          continue
        }
        if (isTeammate() && await processNativeTeammateMailboxProtocol(m, setAppState)) {
          protocolMessagesHandledInline.push(m)
          continue
        }

        const permReq = isPermissionRequest(m.text)
        const sandboxReq = isSandboxPermissionRequest(m.text)
        const shutdownReq = isShutdownRequest(m.text)
        const shutdownApproval = isShutdownApproved(m.text)
        const planApprovalReq = isPlanApprovalRequest(m.text)

        if (permReq) {
          permissionRequests.push(m)
        } else if (sandboxReq) {
          sandboxPermissionRequests.push(m)
        } else if (shutdownReq) {
          shutdownRequests.push(m)
        } else if (shutdownApproval) {
          shutdownApprovals.push(m)
        } else if (planApprovalReq) {
          planApprovalRequests.push(m)
        }
      }

      // Handle permission requests (leader side) - route to ToolUseConfirmQueue
      if (
        permissionRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
        )

        const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

        for (const m of permissionRequests) {
          const parsed = isPermissionRequest(m.text)
          if (!parsed) continue

          if (setToolUseConfirmQueue) {
            const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
            if (!tool) {
              logForDebugging(
                `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
              )
              continue
            }

            const entry: ToolUseConfirm = {
              assistantMessage: createAssistantMessage({ content: '' }),
              tool,
              description: parsed.description,
              input: parsed.input,
              toolUseContext: {} as ToolUseConfirm['toolUseContext'],
              toolUseID: parsed.tool_use_id,
              permissionResult: {
                behavior: 'ask',
                message: parsed.description,
              },
              permissionPromptStartTimeMs: Date.now(),
              workerBadge: {
                name: parsed.agent_id,
                color: 'cyan',
              },
              onUserInteraction() {
                // No-op for tmux workers (no classifier auto-approval)
              },
              onAbort() {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  { decision: 'rejected', resolvedBy: 'leader' },
                  parsed.request_id,
                  teamName,
                )
              },
              onAllow(
                updatedInput: Record<string, unknown>,
                permissionUpdates: PermissionUpdate[],
              ) {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  {
                    decision: 'approved',
                    resolvedBy: 'leader',
                    updatedInput,
                    permissionUpdates,
                  },
                  parsed.request_id,
                  teamName,
                )
              },
              onReject(feedback?: string) {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  {
                    decision: 'rejected',
                    resolvedBy: 'leader',
                    feedback,
                  },
                  parsed.request_id,
                  teamName,
                )
              },
              async recheckPermission() {
                // No-op for tmux workers — permission state is on the worker side
              },
            }

            setToolUseConfirmQueue(queue => {
              if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
                return queue
              }
              return [...queue, entry]
            })
          } else {
            logForDebugging(
              `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
            )
          }
        }

        const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
        if (firstParsed && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
        protocolMessagesHandledInline.push(...permissionRequests)
      }


      if (
        sandboxPermissionRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
        )

        const newSandboxRequests: Array<{
          requestId: string
          workerId: string
          workerName: string
          workerColor?: string
          host: string
          createdAt: number
        }> = []

        for (const m of sandboxPermissionRequests) {
          const parsed = isSandboxPermissionRequest(m.text)
          if (!parsed) continue

          if (!parsed.hostPattern?.host) {
            logForDebugging(
              `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
            )
            continue
          }

          newSandboxRequests.push({
            requestId: parsed.requestId,
            workerId: parsed.workerId,
            workerName: parsed.workerName,
            workerColor: parsed.workerColor,
            host: parsed.hostPattern.host,
            createdAt: parsed.createdAt,
          })
        }

        if (newSandboxRequests.length > 0) {
          setAppState(prev => ({
            ...prev,
            workerSandboxPermissions: {
              ...prev.workerSandboxPermissions,
              queue: [
                ...prev.workerSandboxPermissions.queue,
                ...newSandboxRequests,
              ],
            },
          }))

          const firstRequest = newSandboxRequests[0]
          if (firstRequest && !isLoading && !focusedInputDialog) {
            void sendNotification(
              {
                message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
                notificationType: 'worker_permission_prompt',
              },
              terminal,
            )
          }
        }
        protocolMessagesHandledInline.push(...sandboxPermissionRequests)
      }


      if (
        planApprovalRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
        )

        const leaderExternalMode = toExternalPermissionMode(
          currentAppState.toolPermissionContext.mode,
        )
        const modeToInherit =
          leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

        for (const m of planApprovalRequests) {
          const parsed = isPlanApprovalRequest(m.text)
          if (!parsed) continue

          const approvalResponse = {
            type: 'plan_approval_response',
            requestId: parsed.requestId,
            approved: true,
            timestamp: new Date().toISOString(),
            permissionMode: modeToInherit,
          }

          void writeToMailbox(
            m.from,
            {
              from: TEAM_LEAD_NAME,
              text: jsonStringify(approvalResponse),
              timestamp: new Date().toISOString(),
            },
            teamName,
          )

          const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
          if (taskId) {
            handlePlanApprovalResponse(
              taskId,
              {
                type: 'plan_approval_response',
                requestId: parsed.requestId,
                approved: true,
                timestamp: new Date().toISOString(),
                permissionMode: modeToInherit,
              },
              setAppState,
            )
          }

          logForDebugging(
            `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
          )
          protocolMessagesForLiveContext.push(m)
        }
      }


      if (shutdownRequests.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
        )
        protocolMessagesForLiveContext.push(...shutdownRequests)
      }

      if (
        shutdownApprovals.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
        )

        for (const m of shutdownApprovals) {
          const parsed = isShutdownApproved(m.text)
          if (!parsed) continue

          if (
            parsed.paneId &&
            (parsed.backendType || parsed.paneId.trim().startsWith('process:'))
          ) {
            void (async () => {
              try {
                const backendType = parsed.backendType as BackendType | undefined
                if (
                  backendType === 'process' ||
                  parsed.paneId!.trim().startsWith('process:')
                ) {
                  const teammateEntries = Object.entries(
                    currentAppState.teamContext?.teammates ?? {},
                  ) as Array<[string, { name?: string }]>
                  const expectedAgentId = teammateEntries.find(
                    ([, teammate]) => teammate.name === parsed.from,
                  )?.[0] ??
                    (teamName
                      ? readTeamFile(teamName)?.members.find(
                          member => member.name === parsed.from,
                        )?.agentId
                      : undefined)
                  if (!expectedAgentId || !teamName) {
                    logForDebugging(
                      `[InboxPoller] Skipping process kill for ${parsed.from}: expected agent id or team name unavailable`,
                    )
                    return
                  }
                  const success = await killProcessBackendRuntime(parsed.paneId, {
                    expectedAgentId,
                    teamName,
                  })
                  logForDebugging(
                    `[InboxPoller] Killed process runtime ${parsed.paneId} for ${parsed.from}: ${success}`,
                  )
                } else if (backendType && isPaneBackend(backendType)) {
                  await ensureBackendsRegistered()
                  const insideTmux = await isInsideTmux()
                  const backend = getBackendByType(backendType)
                  const success = await backend?.killPane(
                    parsed.paneId!,
                    !insideTmux,
                  )
                  logForDebugging(
                    `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
                  )
                } else {
                  logForDebugging(
                    `[InboxPoller] Skipping runtime kill for ${parsed.from}: backendType=${parsed.backendType}`,
                  )
                }
              } catch (error) {
                logForDebugging(
                  `[InboxPoller] Failed to kill runtime for ${parsed.from}: ${error}`,
                )
              }
            })()
          }

          const teammateToRemove = parsed.from
          if (teammateToRemove && currentAppState.teamContext?.teammates) {
            const teammateId = (Object.entries(
              currentAppState.teamContext.teammates,
            ) as Array<[string, { name?: string }]>).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]

            if (teammateId) {
              if (teamName) {
                await removeTeammateFromTeamFile(teamName, {
                  agentId: teammateId,
                  name: teammateToRemove,
                })
              }

              const { notificationMessage } = teamName
                ? await unassignTeammateTasks(
                    teamName,
                    teammateId,
                    teammateToRemove,
                    'shutdown',
                  )
                : { notificationMessage: `${teammateToRemove} has shut down.` }

              setAppState(prev => {
                if (!prev.teamContext?.teammates) return prev
                if (!(teammateId in prev.teamContext.teammates)) return prev
                const { [teammateId]: _, ...remainingTeammates } =
                  prev.teamContext.teammates

                const updatedTasks = { ...prev.tasks }
                for (const [tid, task] of Object.entries(updatedTasks)) {
                  if (
                    isInProcessTeammateTask(task) &&
                    task.identity.agentId === teammateId
                  ) {
                    updatedTasks[tid] = {
                      ...task,
                      status: 'completed' as const,
                      endTime: Date.now(),
                    }
                  }
                }

                return {
                  ...prev,
                  tasks: updatedTasks,
                  teamContext: {
                    ...prev.teamContext,
                    teammates: remainingTeammates,
                  },
                  inbox: {
                    messages: [
                      ...prev.inbox.messages,
                      {
                        id: randomUUID(),
                        from: 'system',
                        text: jsonStringify({
                          type: 'teammate_terminated',
                          message: notificationMessage,
                        }),
                        timestamp: new Date().toISOString(),
                        status: 'pending' as const,
                      },
                    ],
                  },
                }
              })
              logForDebugging(
                `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
              )
            }
          }

          protocolMessagesForLiveContext.push(m)
        }
      }

      const handledStructuredIds = protocolMessagesHandledInline.map(
        message => message.messageId,
      )
      if (handledStructuredIds.length > 0) {
        await markMessagesAsReadByIds(agentName, handledStructuredIds, teamName)
      }

      const enqueueMailboxMessages = (
        messages: readonly TeammateMessage[],
        options: { claimedBySessionId?: string } = {},
      ) => {
        if (messages.length === 0) {
          return
        }
        setAppState(prev => {
          const seenMessageIds = new Set(
            prev.inbox.messages
              .map(message => message.messageId)
              .filter((messageId): messageId is string => !!messageId),
          )
          const additions = messages
            .filter(message => !seenMessageIds.has(message.messageId))
            .map(message => createPendingMailboxMirrorMessage(message, options.claimedBySessionId))
          if (additions.length === 0) {
            return prev
          }
          return {
            ...prev,
            inbox: {
              messages: [...prev.inbox.messages, ...additions],
            },
          }
        })
      }

      enqueueMailboxMessages(actionableClaimedRegularMessages, {
        claimedBySessionId: sessionId,
      })
      enqueueMailboxMessages(protocolMessagesForLiveContext)

      const protocolContextIds = protocolMessagesForLiveContext.map(
        message => message.messageId,
      )
      if (protocolContextIds.length > 0) {
        await markMessagesAsReadByIds(agentName, protocolContextIds, teamName)
      }
    } finally {
      pollInFlightRef.current = false
    }
  }, [
    enabled,
    focusedInputDialog,
    isLoading,
    onAgentErrorNotification,
    persistNativeAttachmentFailure,
    setAppState,
    terminal,
    store,
  ])

  // When session becomes idle, deliver any pending messages and clean up processed ones
  useEffect(() => {
    if (!enabled) return

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return
    const sessionId = getSessionId()
    const teamName = currentAppState.teamContext?.teamName
    const now = Date.now()

    const pendingNativeFailureIds = new Set<string>(
      nativeAttachmentFailureWritesRef.current.keys(),
    )
    for (const payload of nativeAttachmentFailureWritesRef.current.values()) {
      if (
        payload.agentName === agentName &&
        !nativeAttachmentFailureWriteInFlightRef.current.has(
          payload.message.messageId!,
        )
      ) {
        void persistNativeAttachmentFailure(payload)
      }
    }
    const liveOwnedMessagesForGate = currentAppState.inbox.messages.filter(message =>
      isLiveInboxMirrorMessageOwnedBySession(message, sessionId) &&
      !pendingNativeFailureIds.has(message.messageId ?? ''),
    )

    if (
      shouldDeferPendingInboxDelivery({
        isLoading,
        focusedInputDialog,
        isTeammateSession: isTeammate(),
        pendingMessages: liveOwnedMessagesForGate,
      })
    ) {
      const retryMs = getWorkSyncIdleDeliveryRetryDelayMs()
      if (retryMs != null && idleDeliveryRetryTimerRef.current == null) {
        idleDeliveryRetryTimerRef.current = setTimeout(() => {
          idleDeliveryRetryTimerRef.current = null
          setIdleDeliveryRetryTick(tick => tick + 1)
        }, retryMs)
      }
      return
    }
    if (idleDeliveryRetryTimerRef.current) {
      clearTimeout(idleDeliveryRetryTimerRef.current)
      idleDeliveryRetryTimerRef.current = null
    }

    const staleMirroredMessageIds = new Set(
      currentAppState.inbox.messages
        .filter(
          message => !isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
        )
        .map(message => message.id),
    )
    if (staleMirroredMessageIds.size > 0) {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(
            message => !staleMirroredMessageIds.has(message.id),
          ),
        },
      }))
    }

    const liveOwnedMessages = liveOwnedMessagesForGate
    const activeBootstrapMessages = liveOwnedMessages.filter(
      message =>
        (message.status === 'pending' || message.status === 'processing') &&
        isBootstrapMailboxInstructionText(message.text) &&
        message.from === TEAM_LEAD_NAME,
    )
    const activeBootstrapMessageIds = new Set(
      activeBootstrapMessages
        .map(message => message.messageId)
        .filter((messageId): messageId is string => !!messageId),
    )
    const {
      actionableMessages: activeOrdinaryMessages,
      ownedMessageIds: activeOrdinaryMessageIds,
    } = getOrdinaryInboxDeliveryState(liveOwnedMessages, pendingNativeFailureIds)
    const transcriptMessages = getMessages()
    const processingOrdinaryMessage = getProcessingOrdinaryMessage({
      messages: activeOrdinaryMessages,
      getAttemptStatus: messageId =>
        ordinaryAttemptsRef.current.get(messageId)?.status,
      shouldProcessCoolingDown: message => {
        if (!message.messageId) {
          return false
        }
        const coolingAttempt = ordinaryAttemptsRef.current.get(message.messageId)
        if (coolingAttempt?.status !== 'cooling_down') {
          return false
        }
        const action = getOrdinaryProcessingAction({
          attempt: coolingAttempt,
          messages: transcriptMessages,
          processingOrdinaryMessage: message,
          memberName: agentName,
          recoveryAttemptCount:
            ordinaryRecoveryRef.current.get(message.messageId)?.attemptCount ?? 0,
          ...(teamName ? { teamName } : {}),
        })
        return (
          action.type === 'finalize' ||
          action.type === 'deliver_assistant_text' ||
          action.type === 'notify_failure'
        )
      },
    })

    for (const [messageId, attempt] of bootstrapAttemptsRef.current.entries()) {
      if (!activeBootstrapMessageIds.has(messageId)) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        bootstrapAttemptsRef.current.delete(messageId)
        observedBootstrapTransportRef.current.delete(messageId)
      }
    }
    for (const [messageId, attempt] of ordinaryAttemptsRef.current.entries()) {
      if (!activeOrdinaryMessageIds.has(messageId)) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(messageId)
      }
    }
    for (const messageId of ordinaryRecoveryRef.current.keys()) {
      if (!activeOrdinaryMessageIds.has(messageId)) {
        ordinaryRecoveryRef.current.delete(messageId)
      }
    }
    for (const [messageId, waitState] of bootstrapReadinessWaitsRef.current) {
      if (!activeBootstrapMessageIds.has(messageId)) {
        if (waitState.timer) {
          clearTimeout(waitState.timer)
        }
        bootstrapReadinessWaitsRef.current.delete(messageId)
      }
    }

    if (processingOrdinaryMessage?.messageId) {
      if (
        ordinaryFinalizationInFlightRef.current.has(
          processingOrdinaryMessage.messageId,
        )
      ) {
        return
      }

      const attempt = ordinaryAttemptsRef.current.get(
        processingOrdinaryMessage.messageId,
      )
      const processingAction = getOrdinaryProcessingAction({
        attempt,
        messages: transcriptMessages,
        processingOrdinaryMessage,
        memberName: agentName,
        recoveryAttemptCount:
          ordinaryRecoveryRef.current.get(processingOrdinaryMessage.messageId)
            ?.attemptCount ?? 0,
        ...(teamName ? { teamName } : {}),
      })

      if (processingAction.type === 'schedule_recovery' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }

        const existingRecovery = ordinaryRecoveryRef.current.get(
          processingOrdinaryMessage.messageId,
        )
        const recoveryState: OrdinaryRecoveryState = {
          attemptCount: (existingRecovery?.attemptCount ?? 0) + 1,
          failureDetail: processingAction.detail,
          taskRef: processingAction.taskRef,
          notifiedLead: existingRecovery?.notifiedLead ?? false,
        }
        ordinaryRecoveryRef.current.set(
          processingOrdinaryMessage.messageId,
          recoveryState,
        )

        const timer = setTimeout(() => {
          if (nativeAttachmentFailureWritesRef.current.has(processingOrdinaryMessage.messageId!)) return
          ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId!)
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingOrdinaryMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS)

        ordinaryAttemptsRef.current.set(processingOrdinaryMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS,
          status: 'cooling_down',
        })

        if (!recoveryState.notifiedLead && teamName) {
          ordinaryRecoveryRef.current.set(processingOrdinaryMessage.messageId, {
            ...recoveryState,
            notifiedLead: true,
          })
          void writeAgentErrorLeadNotification({
            agentName,
            teamName,
            text: isNativeAttachmentMailboxMessage(processingOrdinaryMessage)
              ? `Native teammate attachment turn retry scheduled for message ${processingOrdinaryMessage.messageId}.`
              : buildCodexNativeMailboxTimeoutLeadNotificationText({
                  memberName: agentName,
                  taskRef: recoveryState.taskRef,
                  detail: recoveryState.failureDetail,
                  final: false,
                }),
            summary: isNativeAttachmentMailboxMessage(processingOrdinaryMessage)
              ? 'Native attachment turn retry'
              : 'Codex native mailbox timeout',
          }).catch(error => {
            logForDebugging(
              `[InboxPoller] Failed to notify about recovery for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
          })
        }
        return
      }

      if (
        processingAction.type === 'notify_failure' &&
        attempt &&
        isNativeAttachmentMailboxMessage(processingOrdinaryMessage)
      ) {
        queueNativeAttachmentFailure({
          message: processingOrdinaryMessage,
          agentName,
          ...(teamName ? { teamName } : {}),
          sessionId,
          reasonCode: 'attachment_execution_failed',
          detail: processingAction.detail,
        })
        return
      }

      if (processingAction.type === 'notify_failure' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        const innerRecoveryAttempts =
          ordinaryRecoveryRef.current.get(processingOrdinaryMessage.messageId)
            ?.attemptCount ?? 0
        ordinaryTerminalFailureRef.current.add(processingOrdinaryMessage.messageId)
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            if (teamName) {
              try {
                await writeAgentErrorLeadNotification({
                  agentName,
                  agentError: buildOrdinaryAgentErrorMetadata({
                    reason: processingAction.reason,
                    detail: processingAction.detail,
                    failedMessageId: processingOrdinaryMessage.messageId,
                    runtimeSessionId: sessionId,
                    bootstrapRunId:
                      process.env[TEAMMATE_BOOTSTRAP_RUN_ID_ENV]?.trim() ||
                      undefined,
                    innerRecoveryAttempts,
                  }),
                  teamName,
                  text:
                    processingAction.reason === 'execution_failed'
                      ? buildMailboxExecutionFailureLeadNotificationText({
                          memberName: agentName,
                          taskRef: processingAction.taskRef,
                          detail: processingAction.detail,
                        })
                      : buildCodexNativeMailboxTimeoutLeadNotificationText({
                          memberName: agentName,
                          taskRef: processingAction.taskRef,
                          detail: processingAction.detail,
                          final: true,
                        }),
                  summary:
                    processingAction.reason === 'execution_failed'
                      ? 'Mailbox turn execution failed'
                      : 'Codex native mailbox recovery failed',
                })
              } catch (error) {
                logForDebugging(
                  `[InboxPoller] Failed to notify about mailbox failure for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
                )
              }
            }

            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize ordinary mailbox row ${processingOrdinaryMessage.messageId} after Codex native recovery failure: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'finalize' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)

        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'deliver_assistant_text' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            if (hasGroupMailboxMarker(processingOrdinaryMessage)) {
              try {
                await relayGroupAssistantText({ teamName: teamName!, from: agentName, message: processingOrdinaryMessage, text: processingAction.text })
              } catch (error) {
                // Archived/invalid/unknown group outcome stays in its group. Never guess a private destination or replay.
                logForDebugging(`[InboxPoller] Group reply blocked or unknown: ${String(error)}`)
              }
            } else {
              await relayOrdinaryMailboxAssistantText({
                message: processingOrdinaryMessage,
                agentName,
                text: processingAction.text,
                teamName,
              })
            }
            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to relay plain assistant text for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'schedule_cooldown' && attempt) {
        const cooldownMs =
          processingAction.cooldownMs ?? ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS
        const timer = setTimeout(() => {
          if (nativeAttachmentFailureWritesRef.current.has(processingOrdinaryMessage.messageId!)) return
          ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId!)
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingOrdinaryMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, cooldownMs)

        ordinaryAttemptsRef.current.set(processingOrdinaryMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + cooldownMs,
          status: 'cooling_down',
        })
        return
      }

      if (processingAction.type === 'reset_to_pending') {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === processingOrdinaryMessage.id
                ? { ...message, status: 'pending' as const }
                : message,
            ),
          },
        }))
        return
      }

      if (processingAction.type === 'noop') {
        return
      }
    }

    const pendingMessages = currentAppState.inbox.messages.filter(
      m =>
        m.status === 'pending' &&
        !pendingNativeFailureIds.has(m.messageId ?? '') &&
        m.messageKind !== 'agent_error' &&
        isLiveInboxMirrorMessageOwnedBySession(m, sessionId),
    )
    const bootstrapPendingMessage = getBootstrapPendingMessage({
      pendingMessages,
      isTeammateSession: isTeammate(),
    })

    const processingBootstrapMessage = getBootstrapProcessingMessage({
      messages: activeBootstrapMessages,
    })

    if (processingBootstrapMessage?.messageId) {
      const attempt = bootstrapAttemptsRef.current.get(
        processingBootstrapMessage.messageId,
      )
      const processingAction = getBootstrapProcessingAction({
        attempt,
        // Bootstrap outcome lives in the live REPL transcript. AppState.inbox
        // is store-backed, but the conversation transcript itself is local REPL
        // state, so use the current transcript getter here rather than a stale
        // store snapshot.
        messages: getMessages(),
        processingBootstrapMessage,
      })

      if (processingAction.type === 'finalize' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        bootstrapAttemptsRef.current.delete(processingBootstrapMessage.messageId)
        observedBootstrapTransportRef.current.delete(
          processingBootstrapMessage.messageId,
        )
        onBootstrapConfirmed()
        if (isTeammate()) {
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'bootstrap_confirmed',
            teamName,
            agentName,
            agentId: currentAppState.teamContext?.selfAgentId,
            runId: attempt.nativeAppManaged?.runId ?? sessionId,
            bootstrapRunId: attempt.nativeAppManaged?.runId,
            bootstrapMirrorId: processingBootstrapMessage.messageId,
            ...(attempt.nativeAppManaged
              ? buildNativeAppManagedBootstrapProofFields(attempt.nativeAppManaged)
              : {}),
          })
        }

        void (async () => {
          try {
            const bootstrapMessageIdsToFinalize = getBootstrapMessageIdsToFinalize({
              messages: activeBootstrapMessages,
            })
            await finalizeClaimedMessagesAsRead(
              agentName,
              bootstrapMessageIdsToFinalize.length > 0
                ? bootstrapMessageIdsToFinalize
                : [processingBootstrapMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingBootstrapMessage.id
            const processedBootstrapRowIds = new Set(
              activeBootstrapMessages.map(message => message.id),
            )
            const processedBootstrapMessageIds = new Set(
              bootstrapMessageIdsToFinalize,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId ||
                  processedBootstrapRowIds.has(message.id) ||
                  (!!message.messageId &&
                    processedBootstrapMessageIds.has(message.messageId))
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize bootstrap row ${processingBootstrapMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingBootstrapMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          }
        })()
        return
      }

      if (processingAction.type === 'fail' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        bootstrapAttemptsRef.current.delete(processingBootstrapMessage.messageId)
        observedBootstrapTransportRef.current.delete(
          processingBootstrapMessage.messageId,
        )
        const detail = `Bootstrap failed after teammate startup: ${processingAction.detail}`
        if (isTeammate()) {
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'failed',
            teamName,
            agentName,
            agentId: currentAppState.teamContext?.selfAgentId,
            runId: attempt.nativeAppManaged?.runId ?? sessionId,
            bootstrapRunId: attempt.nativeAppManaged?.runId,
            detail,
          })
        }

        void (async () => {
          try {
            if (teamName) {
              try {
                await writeAgentErrorLeadNotification({
                  agentName,
                  teamName,
                  text: buildAgentErrorNotificationText({
                    memberName: agentName,
                    detail: processingAction.detail,
                    action: 'failed bootstrap after teammate startup',
                  }),
                  summary: 'Agent bootstrap failed',
                })
              } catch (error) {
                logForDebugging(
                  `[InboxPoller] Failed to notify about bootstrap failure for row ${processingBootstrapMessage.messageId}: ${String(error)}`,
                )
              }
            }

            const bootstrapMessageIdsToFinalize = getBootstrapMessageIdsToFinalize({
              messages: activeBootstrapMessages,
            })
            await finalizeClaimedMessagesAsRead(
              agentName,
              bootstrapMessageIdsToFinalize.length > 0
                ? bootstrapMessageIdsToFinalize
                : [processingBootstrapMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingBootstrapMessage.id
            const processedBootstrapRowIds = new Set(
              activeBootstrapMessages.map(message => message.id),
            )
            const processedBootstrapMessageIds = new Set(
              bootstrapMessageIdsToFinalize,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId ||
                  processedBootstrapRowIds.has(message.id) ||
                  (!!message.messageId &&
                    processedBootstrapMessageIds.has(message.messageId))
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize failed bootstrap row ${processingBootstrapMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingBootstrapMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          }
        })()
        return
      }

      if (processingAction.type === 'schedule_cooldown' && attempt) {
        // Leave the row in the existing "processing" state during cooldown so
        // the idle delivery path does not immediately resubmit the same
        // bootstrap prompt in a tight loop when the model fails to comply.
        if (isTeammate()) {
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'bootstrap_submit_deferred',
            teamName,
            agentName,
            agentId: currentAppState.teamContext?.selfAgentId,
            runId: attempt.nativeAppManaged?.runId ?? sessionId,
            bootstrapRunId: attempt.nativeAppManaged?.runId,
            bootstrapMirrorId: processingBootstrapMessage.messageId,
            source: 'useInboxPoller',
            detail: 'bootstrap retry cooldown scheduled',
          })
        }
        const timer = setTimeout(() => {
          bootstrapAttemptsRef.current.delete(processingBootstrapMessage.messageId!)
          observedBootstrapTransportRef.current.delete(
            processingBootstrapMessage.messageId!,
          )
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingBootstrapMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, BOOTSTRAP_RETRY_COOLDOWN_MS)

        bootstrapAttemptsRef.current.set(processingBootstrapMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + BOOTSTRAP_RETRY_COOLDOWN_MS,
          status: 'cooling_down',
        })
        return
      }

      if (processingAction.type === 'reset_to_pending') {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === processingBootstrapMessage.id
                ? { ...message, status: 'pending' as const }
                : message,
            ),
          },
        }))
        return
      }

      if (processingAction.type === 'noop') {
        return
      }
    }

    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // Clean up processed messages (they were already delivered mid-turn as attachments)
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    if (pendingMessages.length === 0) return

    const ordinaryPendingMessage =
      bootstrapPendingMessage == null
        ? getOrdinaryPendingMessage<PendingInboxMirrorMessage>({
            pendingMessages,
            deferUnticketedWorkSyncNudges: shouldDeferUnticketedWorkSyncNudges(),
          })
        : undefined

    void (async () => {
      if (
        ordinaryPendingMessage &&
        shouldHoldTicketedWorkSyncUntilExactMatch(ordinaryPendingMessage)
      ) {
        logForDebugging(
          '[InboxPoller] Holding ticketed work-sync envelope until the exact reserved ticket matches',
        )
        return
      }
      if (!bootstrapPendingMessage && !ordinaryPendingMessage) {
        logForDebugging(
          '[InboxPoller] Holding automatic work-sync until a matching D1 ticket is reserved',
        )
        return
      }
      logForDebugging(
        `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
      )

      const bootstrapPrompt =
        bootstrapPendingMessage != null
          ? isNativeAppManagedBootstrapInstructionText(bootstrapPendingMessage.text)
            ? buildNativeAppManagedBootstrapPrivatePrompt()
            : getBootstrapInlineHandoffPrompt({
                bootstrapInstructionText: bootstrapPendingMessage.text,
                memberName: currentAppState.teamContext?.selfAgentName,
                teamName: currentAppState.teamContext?.teamName,
              })
          : null

      if (bootstrapPendingMessage?.messageId) {
        const nativeAppManagedBootstrap = isNativeAppManagedBootstrapInstructionText(
          bootstrapPendingMessage.text,
        )
        const effectiveTools = assembleToolPool(
          currentAppState.toolPermissionContext,
          currentAppState.mcp.tools,
        )
        const memberBriefingCallableNow =
          isBootstrapMemberBriefingCallableNow({
            toolSearchEnabledOptimistic: isToolSearchEnabledOptimistic(),
            tools: effectiveTools,
          })
        const shouldBypassReadinessWait = shouldSkipBootstrapReadinessWait({
          bootstrapInstructionText: bootstrapPendingMessage.text,
          teamName: currentAppState.teamContext?.teamName,
          memberName: currentAppState.teamContext?.selfAgentName,
          toolCallableNow: memberBriefingCallableNow,
        }) || nativeAppManagedBootstrap
        const readinessWait = bootstrapReadinessWaitsRef.current.get(
          bootstrapPendingMessage.messageId,
        )
        const readinessDecision = shouldBypassReadinessWait
          ? ({ type: 'proceed' } as const)
          : getBootstrapReadinessDecision({
              now,
              toolCallableNow: memberBriefingCallableNow,
              waitStartedAt: readinessWait?.startedAt,
            })

        if (readinessDecision.type === 'wait') {
          if (!readinessWait) {
            const timer = setTimeout(() => {
              setBootstrapReadinessTick(value => value + 1)
            }, readinessDecision.remainingMs)
            bootstrapReadinessWaitsRef.current.set(
              bootstrapPendingMessage.messageId,
              {
                startedAt: now,
                timer,
              },
            )
            logForDebugging(
              `[InboxPoller] Waiting up to ${BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS}ms for member_briefing to appear before first bootstrap turn`,
            )
          }
          return
        }

        if (readinessWait) {
          if (readinessWait.timer) {
            clearTimeout(readinessWait.timer)
          }
          bootstrapReadinessWaitsRef.current.delete(
            bootstrapPendingMessage.messageId,
          )
          if (!memberBriefingCallableNow && !shouldBypassReadinessWait) {
            logForDebugging(
              '[InboxPoller] member_briefing still not callable after bootstrap readiness grace period; falling back to current bootstrap handoff behavior',
            )
          }
        }
      }
      const ordinaryRecovery =
        ordinaryPendingMessage?.messageId != null
          ? ordinaryRecoveryRef.current.get(ordinaryPendingMessage.messageId)
          : undefined
      let groupCatalog: unknown
      let groupHistory: readonly GroupMailboxHistoryMessage[] | undefined
      let groupSentHistory: readonly GroupMailboxHistoryMessage[] | undefined
      let groupOwnPosts: readonly GroupMailboxOwnPostProof[] | undefined
      if (ordinaryPendingMessage && hasGroupMailboxMarker(ordinaryPendingMessage) && teamName && agentName) {
        // Native Codex group turns stay ephemeral. Read only its own prior
        // finalized physical deliveries; group/run/receiver fences are applied by the prompt builder.
        if (shouldUseCodexProviderRoutingForCurrentProcess()) {
          try {
            groupHistory = await readGroupMailboxContext(agentName, teamName)
            // Canonical rows are filtered here and then fenced by their physical
            // relay into this receiver/run. Other user inbox content never enters the prompt.
            groupSentHistory = (await readGroupMailboxContext('user', teamName)).filter(row =>
              row.from === agentName && row.groupChatId === ordinaryPendingMessage.groupChatId && row.source === 'runtime_delivery')
            groupOwnPosts = findGroupMailboxOwnPostProofs({
              messages: getMessages(), turns: groupHostTurnsRef.current, teamName, memberName: agentName,
              current: { ...ordinaryPendingMessage, to: agentName }, history: groupHistory, sentHistory: groupSentHistory,
            })
          }
          catch {
            groupHistory = undefined; groupSentHistory = undefined; groupOwnPosts = undefined
            logForDebugging('[InboxPoller] Prior group context unavailable')
          }
        }
        try { groupCatalog = await readFreshGroupChatCatalog(teamName, agentName) }
        catch (error) { logForDebugging(`[InboxPoller] Fresh group catalog unavailable: ${String(error)}`) }
      }
      const ordinaryPrompt =
        ordinaryPendingMessage != null
          ? ordinaryRecovery != null
            ? getOrdinaryRecoveryInlineHandoffPrompt({
                from: ordinaryPendingMessage.from,
                text: ordinaryPendingMessage.text,
                timestamp: ordinaryPendingMessage.timestamp,
                failureDetail: ordinaryRecovery.failureDetail,
                taskRef: ordinaryRecovery.taskRef,
              })
            : getOrdinaryInlineHandoffPrompt({
                ...ordinaryPendingMessage,
                groupCatalog,
                groupHistory,
                groupSentHistory,
                groupOwnPosts,
                to: agentName,
                from: ordinaryPendingMessage.from,
                source: ordinaryPendingMessage.source,
                memberName: agentName,
                messageId: ordinaryPendingMessage.messageId,
                text: ordinaryPendingMessage.text,
                timestamp: ordinaryPendingMessage.timestamp,
                ...(teamName ? { teamName } : {}),
              })
          : null
      // The bootstrap turn is submitted through handleIncomingPrompt(), which
      // bypasses processUserInput/getAttachmentMessages. Inline the claimed
      // bootstrap text here so teammate bootstrap never depends on hidden
      // teammate_mailbox attachment delivery.
      const prompt =
        bootstrapPrompt ??
        ordinaryPrompt ??
        getQueuedMailboxMetaPrompt({
          pendingMessages: bootstrapPendingMessage
            ? [bootstrapPendingMessage]
            : pendingMessages,
          isTeammateSession: isTeammate(),
        })
      let promptContent: string | ContentBlockParam[] = prompt

      if (
        ordinaryPendingMessage &&
        isNativeAttachmentMailboxMessage(ordinaryPendingMessage)
      ) {
        const preparationId = ordinaryPendingMessage.messageId!
        if (nativeAttachmentPreparationInFlightRef.current.has(preparationId)) {
          return
        }
        nativeAttachmentPreparationInFlightRef.current.add(preparationId)
        try {
          const stillIdle = isIncomingPromptIdle?.() ??
            (!isLoading && !focusedInputDialog)
          if (!stillIdle) {
            return
          }
          const provider: NativeAttachmentProvider =
            shouldUseCodexProviderRoutingForCurrentProcess()
              ? 'codex'
              : 'anthropic'
          promptContent = await prepareNativeAttachmentPromptContent({
            message: {
              ...ordinaryPendingMessage,
              ...(teamName ? { teamName } : {}),
            },
            provider,
            replyProtocolText: prompt,
            runtimeInstanceId,
          })

          const latestState = store.getState()
          const latestMessage = latestState.inbox.messages.find(
            message => message.id === ordinaryPendingMessage.id,
          )
          const currentAgentName = getAgentNameToPoll(latestState)
          if (
            !latestMessage ||
            latestMessage.status !== 'pending' ||
            currentAgentName !== agentName ||
            !isLiveInboxMirrorMessageOwnedBySession(latestMessage, sessionId) ||
            latestMessage.nativeAttachmentDelivery
              ?.recipientRuntimeInstanceId !== runtimeInstanceId ||
            !(isIncomingPromptIdle?.() ?? (!isLoading && !focusedInputDialog))
          ) {
            return
          }
        } catch (error) {
          const reasonCode =
            error instanceof NativeAttachmentPreparationError
              ? error.reasonCode
              : 'attachment_path_invalid'
          logForDebugging(
            `[InboxPoller] Native attachment preparation failed for ${ordinaryPendingMessage.messageId}: ${String(error)}`,
          )
          queueNativeAttachmentFailure({
            message: ordinaryPendingMessage,
            agentName,
            ...(teamName ? { teamName } : {}),
            sessionId,
            reasonCode,
            detail: reasonCode,
          })
          return
        } finally {
          nativeAttachmentPreparationInFlightRef.current.delete(preparationId)
        }
      }

      const nativeBootstrapInjection =
        bootstrapPendingMessage != null &&
        isNativeAppManagedBootstrapInstructionText(bootstrapPendingMessage.text)
          ? await getNativeAppManagedBootstrapContextInjection?.()
          : null
      if (
        bootstrapPendingMessage != null &&
        isNativeAppManagedBootstrapInstructionText(bootstrapPendingMessage.text) &&
        !nativeBootstrapInjection
      ) {
        if (isTeammate()) {
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'failed',
            teamName,
            agentName,
            agentId: currentAppState.teamContext?.selfAgentId,
            runId: sessionId,
            source: 'useInboxPoller',
            detail: 'Native app-managed bootstrap context was unavailable.',
          })
        }
        return
      }

      const bootstrapTransportBase =
        bootstrapPendingMessage?.messageId && isTeammate()
          ? {
              teamName,
              agentName,
              agentId: currentAppState.teamContext?.selfAgentId,
              runId: nativeBootstrapInjection?.runId ?? sessionId,
              bootstrapRunId: nativeBootstrapInjection?.runId,
              bootstrapMirrorId: bootstrapPendingMessage.messageId,
              source: 'useInboxPoller',
            }
          : null

      if (
        bootstrapTransportBase &&
        !observedBootstrapTransportRef.current.has(
          bootstrapTransportBase.bootstrapMirrorId,
        )
      ) {
        observedBootstrapTransportRef.current.add(
          bootstrapTransportBase.bootstrapMirrorId,
        )
        void writeChildOwnedTeammateRuntimeEvent({
          type: 'bootstrap_prompt_observed',
          ...bootstrapTransportBase,
          detail: [
            `pendingMessages=${pendingMessages.length}`,
            `bootstrapMessageAgeMs=${formatBootstrapMessageAgeMs(bootstrapPendingMessage?.timestamp, now) ?? 'unknown'}`,
            `nativeAppManaged=${bootstrapPendingMessage != null && isNativeAppManagedBootstrapInstructionText(bootstrapPendingMessage.text) ? 'true' : 'false'}`,
            `nativeContextLoaded=${nativeBootstrapInjection ? 'true' : 'false'}`,
            `transcriptActivitySignature=${transcriptActivitySignature ? 'present' : 'empty'}`,
          ].join('; '),
        })
      }

      if (bootstrapTransportBase) {
        void writeChildOwnedTeammateRuntimeEvent({
          type: 'bootstrap_submit_attempted',
          ...bootstrapTransportBase,
          detail: [
            `promptChars=${prompt.length}`,
            `prefixMessages=${nativeBootstrapInjection?.prefixMessages.length ?? 0}`,
            `pendingMessages=${pendingMessages.length}`,
          ].join('; '),
        })
      }

      const submitted = onSubmitTeammateMessage(promptContent, {
        isMeta: true,
        // The selected delivery envelope owns scope. Prompt text, including
        // quoted protocol markers in an ordinary DM, cannot select a thread.
        conversationScope: bootstrapPendingMessage
          ? 'bootstrap'
          : ordinaryPendingMessage && hasGroupMailboxMarker(ordinaryPendingMessage)
            ? 'group'
            : 'direct',
        submissionKind: resolveIncomingMailboxSubmissionKind({
          bootstrapPendingMessage,
          ordinaryPendingMessage,
        }),
        ...(nativeBootstrapInjection
          ? { prefixMessages: nativeBootstrapInjection.prefixMessages }
          : {}),
      })
      if (!submitted.accepted) {
        if (bootstrapTransportBase) {
          const detail = [
            formatPromptSubmitRejectionDetail(submitted),
            `promptChars=${prompt.length}`,
            `prefixMessages=${nativeBootstrapInjection?.prefixMessages.length ?? 0}`,
          ].join('; ')
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'bootstrap_submit_rejected',
            ...bootstrapTransportBase,
            retryable: true,
            detail,
          })
        }
        logForDebugging(
          `[InboxPoller] Submission rejected, keeping messages queued: ${formatPromptSubmitRejectionDetail(submitted)}`,
        )
        return
      }

      if (ordinaryPendingMessage?.messageId && ordinaryPendingMessage.groupChatId &&
          ordinaryPendingMessage.groupRunKey && submitted.userMessageUuid && teamName &&
          shouldUseCodexProviderRoutingForCurrentProcess()) {
        groupHostTurnsRef.current.push({
          submitUserMessageUuid: submitted.userMessageUuid, teamName, memberName: agentName,
          groupChatId: ordinaryPendingMessage.groupChatId, groupRunKey: ordinaryPendingMessage.groupRunKey,
          physicalMessageId: ordinaryPendingMessage.messageId,
        })
        if (groupHostTurnsRef.current.length > 64) groupHostTurnsRef.current.shift()
      }

      if (nativeBootstrapInjection) {
        try {
          await nativeBootstrapInjection.markContextLoaded()
          if (bootstrapTransportBase) {
            void writeChildOwnedTeammateRuntimeEvent({
              type: 'bootstrap_context_loaded',
              ...bootstrapTransportBase,
              bootstrapProofToken: nativeBootstrapInjection.bootstrapProofToken,
              contextHash: nativeBootstrapInjection.contextHash,
              briefingHash: nativeBootstrapInjection.briefingHash,
            })
          }
        } catch (error) {
          if (bootstrapTransportBase) {
            void writeChildOwnedTeammateRuntimeEvent({
              type: 'failed',
              ...bootstrapTransportBase,
              detail: `Native app-managed bootstrap context load failed: ${String(error)}`,
            })
          }
          return
        }
      }

      if (bootstrapTransportBase && !submitted.userMessageUuid) {
        void writeChildOwnedTeammateRuntimeEvent({
          type: 'bootstrap_submit_accepted_without_uuid',
          ...bootstrapTransportBase,
          retryable: false,
          detail: 'submit accepted without userMessageUuid',
        })
        return
      }

      if (bootstrapPendingMessage?.messageId && submitted.userMessageUuid) {
        if (isTeammate()) {
          void writeChildOwnedTeammateRuntimeEvent({
            type: 'bootstrap_submitted',
            ...(bootstrapTransportBase ?? {
              teamName,
              agentName,
              agentId: currentAppState.teamContext?.selfAgentId,
              runId: nativeBootstrapInjection?.runId ?? sessionId,
              bootstrapRunId: nativeBootstrapInjection?.runId,
              source: 'useInboxPoller',
            }),
            bootstrapMessageId: submitted.userMessageUuid,
          })
        }
        bootstrapAttemptsRef.current.set(bootstrapPendingMessage.messageId, {
          submitUserMessageUuid: submitted.userMessageUuid,
          submittedAt: Date.now(),
          cooldownUntil: 0,
          status: 'in_flight',
          timer: null,
          ...(nativeBootstrapInjection
            ? {
                nativeAppManaged: {
                  contextHash: nativeBootstrapInjection.contextHash,
                  briefingHash: nativeBootstrapInjection.briefingHash,
                  bootstrapProofToken:
                    nativeBootstrapInjection.bootstrapProofToken,
                  runId: nativeBootstrapInjection.runId,
                },
              }
            : {}),
        })

        const bootstrapRowId = bootstrapPendingMessage.id
        const obsoleteBootstrapRows = activeBootstrapMessages.filter(
          message => message.messageId !== bootstrapPendingMessage.messageId,
        )
        const obsoleteBootstrapMessageIds = getBootstrapMessageIdsToFinalize({
          messages: obsoleteBootstrapRows,
        })
        if (obsoleteBootstrapRows.length > 0) {
          const obsoleteBootstrapRowIds = new Set(
            obsoleteBootstrapRows.map(message => message.id),
          )
          const obsoleteBootstrapMessageIdSet = new Set(
            obsoleteBootstrapMessageIds,
          )
          void (async () => {
            try {
              await finalizeClaimedMessagesAsRead(
                agentName,
                obsoleteBootstrapMessageIds,
                sessionId,
                teamName,
              )
              setAppState(prev => ({
                ...prev,
                inbox: {
                  messages: prev.inbox.messages.map(message =>
                    obsoleteBootstrapRowIds.has(message.id) ||
                    (!!message.messageId &&
                      obsoleteBootstrapMessageIdSet.has(message.messageId))
                      ? { ...message, status: 'processed' as const }
                      : message,
                  ),
                },
              }))
            } catch (error) {
              logForDebugging(
                `[InboxPoller] Failed to finalize obsolete bootstrap rows after submit: ${String(error)}`,
              )
            }
          })()
        }
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === bootstrapRowId
                ? { ...message, status: 'processing' as const }
                : message,
            ),
          },
        }))
      } else if (ordinaryPendingMessage?.messageId) {
        if (!submitted.userMessageUuid) {
          if (isNativeAttachmentMailboxMessage(ordinaryPendingMessage)) {
            queueNativeAttachmentFailure({
              message: ordinaryPendingMessage,
              agentName,
              ...(teamName ? { teamName } : {}),
              sessionId,
              reasonCode: 'attachment_submission_uncorrelated',
              detail: 'attachment_submission_uncorrelated',
            })
            return
          }
          logForDebugging(
            `[InboxPoller] Ordinary mailbox submission for ${ordinaryPendingMessage.messageId} was accepted without a transcript user message UUID; keeping row pending`,
          )
          return
        }

        ordinaryAttemptsRef.current.set(ordinaryPendingMessage.messageId, {
          submitUserMessageUuid: submitted.userMessageUuid,
          submittedAt: Date.now(),
          cooldownUntil: 0,
          status: 'in_flight',
          timer: null,
        })

        const ordinaryRowId = ordinaryPendingMessage.id
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === ordinaryRowId
                ? { ...message, status: 'processing' as const }
                : message,
            ),
          },
        }))
      }
    })()
  }, [
    bootstrapReadinessTick,
    transcriptActivitySignature,
    mcpToolSignature,
    enabled,
    isLoading,
    focusedInputDialog,
    getMessages,
    runtimeInstanceId,
    onSubmitTeammateMessage,
    isIncomingPromptIdle,
    getNativeAppManagedBootstrapContextInjection,
    onBootstrapConfirmed,
    persistNativeAttachmentFailure,
    queueNativeAttachmentFailure,
    setAppState,
    inboxStateSignature,
    idleDeliveryRetryTick,
    store,
  ])

  // Poll if running as a teammate or as a team lead
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // Initial poll on mount (only once)
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // Use store.getState() to avoid dependency on appState object
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (agentName) {
      hasDoneInitialPollRef.current = true
      if (!didWriteInboxPollerReadyRef.current && isTeammate()) {
        didWriteInboxPollerReadyRef.current = true
        const teamName = getTeamName(currentAppState.teamContext)
        const agentId = getAgentId() ?? currentAppState.teamContext?.selfAgentId
        const runId = getSessionId()
        const bootstrapRunId =
          process.env[TEAMMATE_BOOTSTRAP_RUN_ID_ENV]?.trim() || undefined
        void (async () => {
          await writeChildOwnedTeammateRuntimeEvent({
            type: 'runtime_ready',
            teamName,
            agentName,
            agentId,
            runId,
            bootstrapRunId,
            cwd: getCwd(),
            source: 'useInboxPoller',
            detail: 'inbox poller mounted',
          })
          await writeChildOwnedTeammateRuntimeEvent({
            type: 'inbox_poller_ready',
            teamName,
            agentName,
            agentId,
            runId,
            bootstrapRunId,
            source: 'useInboxPoller',
          })
          const providerId =
            process.env.CLAUDE_CODE_ENTRY_PROVIDER?.trim().toLowerCase()
          if (
            await isNativeAttachmentRootReady() &&
            (providerId === undefined ||
              providerId === '' ||
              providerId === 'codex' ||
              providerId === 'anthropic')
          ) {
            onNativeInboxAttachmentsReady?.({
              pid: process.pid,
              bootstrapRunId: bootstrapRunId || runId,
              runtimeRunId: runId,
            })
          }
        })()
      }
      void poll()
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, onNativeInboxAttachmentsReady, poll, store])
}

/** Shared inline protocol owner; SDK permission prompts themselves remain in StructuredIO. */
export async function processNativeTeammateMailboxProtocol(
  message: TeammateMessage,
  setAppState: (update: (previous: AppState) => AppState) => void,
): Promise<boolean> {
  const permission = isPermissionResponse(message.text)
  if (permission) {
    if (hasPermissionCallback(permission.request_id)) {
      processMailboxPermissionResponse(permission.subtype === 'success'
        ? { requestId: permission.request_id, decision: 'approved', updatedInput: permission.response?.updated_input, permissionUpdates: permission.response?.permission_updates }
        : { requestId: permission.request_id, decision: 'rejected', feedback: permission.error })
    }
    return true
  }
  const sandbox = isSandboxPermissionResponse(message.text)
  if (sandbox) {
    if (hasSandboxPermissionCallback(sandbox.requestId)) {
      processSandboxPermissionResponse({ requestId: sandbox.requestId, host: sandbox.host, allow: sandbox.allow })
      setAppState(previous => ({ ...previous, pendingSandboxRequest: null }))
    }
    return true
  }
  const update = isTeamPermissionUpdate(message.text)
  if (update) {
    if (update.permissionUpdate?.rules && update.permissionUpdate?.behavior) {
      setAppState(previous => ({
        ...previous,
        toolPermissionContext: applyPermissionUpdate(previous.toolPermissionContext, {
          type: 'addRules', rules: update.permissionUpdate.rules,
          behavior: update.permissionUpdate.behavior, destination: 'session',
        }),
      }))
    }
    return true
  }
  const mode = isModeSetRequest(message.text)
  if (mode) {
    if (message.from === TEAM_LEAD_NAME) {
      const target = permissionModeFromString(mode.mode)
      setAppState(previous => ({
        ...previous,
        toolPermissionContext: applyPermissionUpdate(previous.toolPermissionContext, {
          type: 'setMode', mode: toExternalPermissionMode(target), destination: 'session',
        }),
      }))
      const teamName = getTeamName()
      const agentName = getAgentName()
      if (teamName && agentName) await setMemberMode(teamName, agentName, target)
    }
    return true
  }
  const plan = isPlanApprovalResponse(message.text)
  if (plan) {
    if (message.from === TEAM_LEAD_NAME && plan.approved && isPlanModeRequired()) {
      setAppState(previous => ({
        ...previous,
        toolPermissionContext: applyPermissionUpdate(previous.toolPermissionContext, {
          type: 'setMode', mode: toExternalPermissionMode(plan.permissionMode ?? 'default'), destination: 'session',
        }),
      }))
    }
    return true
  }
  return isLegacyPlanApprovalResponseMessage(message.text)
}
