import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, type UUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Message } from '../../types/message.js'
import { createAssistantAPIErrorMessage, createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { readMailbox, writeToMailbox } from '../../utils/teammateMailbox.js'
import { readTeammateRuntimeEvents, TEAMMATE_RUNTIME_EVENTS_ENV } from '../../utils/swarm/teammateRuntimeEvents.js'
import {
  buildNativeAppManagedBootstrapPrivatePrompt,
  hashNativeBootstrapText,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
  NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE,
  prepareNativeAppManagedBootstrapContextFile,
} from './nativeAppManagedBootstrapContext.js'
import { createNativeAppManagedSdkRuntime } from './nativeAppManagedSdkRuntime.js'
import { buildWorkSyncAdmissionCapabilityPath } from '../../utils/workSyncAdmissionCapability.js'
import { hasPermissionCallback, registerPermissionCallback, unregisterPermissionCallback } from '../../hooks/useSwarmPermissionPoller.js'

describe('native SDK private bootstrap and subsequent inbox delivery', () => {
  const keys = ['CLAUDE_CONFIG_DIR', NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV, TEAMMATE_RUNTIME_EVENTS_ENV, 'CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT']
  let saved: (string | undefined)[]
  let root: string
  let eventsPath: string
  let messages: Message[]
  let submitted: { prompt: string | ContentBlockParam[]; uuid: UUID }[]
  const closeConsumers = new Set<() => Promise<void>>()

  beforeEach(async () => {
    saved = keys.map(key => process.env[key])
    root = await mkdtemp(join(tmpdir(), 'sdk-native-bootstrap-'))
    process.env.CLAUDE_CONFIG_DIR = root
    eventsPath = join(root, 'events.jsonl')
    process.env[TEAMMATE_RUNTIME_EVENTS_ENV] = eventsPath
    const environment = await prepareNativeAppManagedBootstrapContextFile({
      teamName: 'sdk-team', memberName: 'worker', agentId: 'worker@sdk-team',
      runId: 'launch-run', provider: 'anthropic', bootstrapProofToken: 'test-proof',
      spec: {
        schemaVersion: 1, mode: 'startup_context_file', contextText: 'Assigned work from the real startup handoff',
        contextHash: hashNativeBootstrapText('Assigned work from the real startup handoff'),
        briefingHash: hashNativeBootstrapText('briefing'), generatedAt: new Date().toISOString(),
      },
    })
    process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV] = environment[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
    messages = []
    submitted = []
    await writeToMailbox('worker', {
      messageId: 'bootstrap-row', from: 'team-lead', timestamp: new Date().toISOString(),
      text: buildNativeAppManagedBootstrapPrivatePrompt(),
    }, 'sdk-team')
  })

  afterEach(async () => {
    unregisterPermissionCallback('native-sdk-permission-while-busy')
    for (const close of closeConsumers) await close()
    closeConsumers.clear()
    for (let index = 0; index < keys.length; index++) {
      if (saved[index] === undefined) delete process.env[keys[index]!]
      else process.env[keys[index]!] = saved[index]
    }
    await rm(root, { recursive: true, force: true })
  })

  function runtime() {
    const consumer = createNativeAppManagedSdkRuntime({
      agentName: 'worker', agentId: 'worker@sdk-team', teamName: 'sdk-team', sessionId: 'runtime-session',
      getMessages: () => messages,
      setAppState: () => { throw new Error('Unexpected protocol mutation in bootstrap-only fixture') },
      isQueryLoopIdle: () => true,
      groupChatReady: () => false,
      submit: (prompt, uuid) => submitted.push({ prompt, uuid }),
    })
    closeConsumers.add(consumer.close)
    return consumer
  }

  async function readyRuntime() {
    const consumer = runtime()
    await consumer.publishReady()
    await consumer.poll()
    const bootstrap = submitted[0]!
    await consumer.beforeTurn(bootstrap.uuid)
    messages.push(createUserMessage({ content: bootstrap.prompt, uuid: bootstrap.uuid }))
    messages.push(createAssistantMessage({ content: 'Startup context loaded.' }))
    await consumer.completeTurn(bootstrap.uuid)
    return consumer
  }

  async function nativeAttachmentFixture(fault?: 'stale-instance' | 'changed-bytes') {
    const attachmentRoot = join(root, 'attachments')
    await mkdir(attachmentRoot)
    process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT = attachmentRoot
    const consumer = await readyRuntime()
    const capability = JSON.parse(await readFile(buildWorkSyncAdmissionCapabilityPath({ teamName: 'sdk-team', memberName: 'worker' }), 'utf8'))
    const messageId = 'actual-text-attachment'
    const messageDir = join(attachmentRoot, 'sdk-team', messageId)
    await mkdir(messageDir, { recursive: true })
    const filePath = join(messageDir, 'attachment-1--note.txt')
    const bytes = Buffer.from('Source-grounded attachment: Привет 世界', 'utf8')
    await writeFile(filePath, bytes)
    await writeToMailbox('worker', {
      messageId, from: 'team-lead', text: 'Read the attached source.', timestamp: new Date().toISOString(),
      nativeAttachmentDelivery: {
        version: 1, recipientRuntimeInstanceId: fault === 'stale-instance' ? 'superseded-runtime' : capability.runtimeInstanceId,
      },
      attachments: [{
        id: 'attachment-1', filename: 'note.txt', mimeType: 'text/plain',
        filePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      }],
    }, 'sdk-team')
    if (fault === 'changed-bytes') await writeFile(filePath, Buffer.from('x'.repeat(bytes.length)))
    return { consumer, bytes, messageId }
  }

  test('consumes a legitimate permission response while its bootstrap query is busy', async () => {
    const consumer = runtime()
    await consumer.publishReady()
    await consumer.poll()
    await consumer.beforeTurn(submitted[0]!.uuid)
    const decision = Promise.withResolvers<Record<string, unknown> | undefined>()
    registerPermissionCallback({
      requestId: 'native-sdk-permission-while-busy', toolUseId: 'existing-tool-use',
      onAllow: updatedInput => decision.resolve(updatedInput),
      onReject: reason => decision.reject(new Error(reason)),
    })
    await writeToMailbox('worker', {
      messageId: 'permission-answer', from: 'team-lead', timestamp: new Date().toISOString(),
      text: JSON.stringify({ type: 'permission_response', request_id: 'native-sdk-permission-while-busy', subtype: 'success', response: { updated_input: { command: 'approved-existing-command' } } }),
    }, 'sdk-team')
    await consumer.poll()
    expect(hasPermissionCallback('native-sdk-permission-while-busy')).toBe(false)
    expect(await decision.promise).toEqual({ command: 'approved-existing-command' })
    const mailbox = await readMailbox('worker', 'sdk-team')
    expect(mailbox.find(message => message.messageId === 'permission-answer')?.read).toBe(true)
    expect(mailbox.find(message => message.messageId === 'bootstrap-row')?.read).toBe(false)
    expect(submitted).toHaveLength(1)
  })

  test('delivers a real lifecycle protocol row as one live turn instead of ignoring it', async () => {
    const consumer = await readyRuntime()
    const timestamp = new Date().toISOString()
    await writeToMailbox('worker', {
      messageId: 'shutdown-row', from: 'team-lead', timestamp,
      text: JSON.stringify({ type: 'shutdown_request', requestId: 'shutdown-existing', from: 'team-lead', timestamp }),
    }, 'sdk-team')
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    const turn = submitted[1]!
    expect(turn.prompt).toContain('shutdown_request')
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    messages.push(createAssistantMessage({ content: 'Shutdown request processed.' }))
    await consumer.completeTurn(turn.uuid)
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === 'shutdown-row')?.read).toBe(true)
  })

  test('prepares actual hashed attachment bytes for the current real runtime instance', async () => {
    const { consumer, bytes, messageId } = await nativeAttachmentFixture()
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    const turn = submitted[1]!
    expect(Array.isArray(turn.prompt)).toBe(true)
    expect(JSON.stringify(turn.prompt)).toContain(bytes.toString('utf8'))
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    messages.push(createAssistantMessage({ content: 'Source file read.' }))
    await consumer.completeTurn(turn.uuid)
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === messageId)?.read).toBe(true)
  })

  test.each([
    { fault: 'stale-instance' as const, reason: 'recipient_runtime_mismatch' },
    { fault: 'changed-bytes' as const, reason: 'attachment_digest_mismatch' },
  ])('writes one immutable USER failure before finalizing $fault attachment', async ({ fault, reason }) => {
    const { consumer, messageId } = await nativeAttachmentFixture(fault)
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    const failures = (await readMailbox('user', 'sdk-team')).filter(message => message.nativeAttachmentFailure?.originalMessageId === messageId)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ messageKind: 'agent_error', nativeAttachmentFailure: { originalMessageId: messageId, reasonCode: reason } })
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === messageId)?.read).toBe(true)
    await consumer.poll()
    await consumer.poll()
    expect((await readMailbox('user', 'sdk-team')).filter(message => message.nativeAttachmentFailure?.originalMessageId === messageId)).toEqual(failures)
    expect(submitted).toHaveLength(1)
  })

  test('refuses to finalize when the immutable USER failure identity has conflicting contents', async () => {
    const { consumer, messageId } = await nativeAttachmentFixture('stale-instance')
    const failureId = `native-attachment-failure-${createHash('sha256').update(messageId).digest('hex').slice(0, 24)}`
    await writeToMailbox('user', {
      messageId: failureId, from: 'worker', text: 'Conflicting pre-existing contents.', timestamp: new Date().toISOString(),
    }, 'sdk-team')
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === messageId)?.read).toBe(false)
    const conflicted = await readMailbox('user', 'sdk-team')
    expect(conflicted).toHaveLength(1)
    expect(conflicted[0]?.text).toBe('Conflicting pre-existing contents.')
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === messageId)?.read).toBe(false)
    expect(await readMailbox('user', 'sdk-team')).toEqual(conflicted)
  })

  test('reports attachment execution failure without re-invoking its accepted task', async () => {
    const { consumer, messageId } = await nativeAttachmentFixture()
    await consumer.poll()
    const turn = submitted[1]!
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    messages.push(createAssistantAPIErrorMessage({ content: 'API Error: request failed' }))
    await consumer.completeTurn(turn.uuid)
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    expect((await readMailbox('user', 'sdk-team')).filter(message => message.nativeAttachmentFailure?.originalMessageId === messageId)).toHaveLength(1)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === messageId)?.read).toBe(true)
  })

  test('relays a human plain-assistant fallback once and only then finalizes its mailbox row', async () => {
    const consumer = await readyRuntime()
    await writeToMailbox('worker', { messageId: 'human-fallback', from: 'user', text: 'Summarize the completed task.', timestamp: new Date().toISOString() }, 'sdk-team')
    await consumer.poll()
    const turn = submitted[1]!
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    messages.push(createAssistantMessage({ content: 'The completed task produced the requested result.' }))
    await consumer.completeTurn(turn.uuid)
    const replies = await readMailbox('user', 'sdk-team')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.text).toBe('The completed task produced the requested result.')
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === 'human-fallback')?.read).toBe(true)
    await consumer.completeTurn(turn.uuid)
    await consumer.poll()
    expect(await readMailbox('user', 'sdk-team')).toEqual(replies)
    expect(submitted).toHaveLength(2)
  })

  test('does not duplicate a human reply already proven by successful SendMessage', async () => {
    const consumer = await readyRuntime()
    await writeToMailbox('worker', { messageId: 'human-tool-reply', from: 'user', text: 'Reply through the team tool.', timestamp: new Date().toISOString() }, 'sdk-team')
    await consumer.poll()
    const turn = submitted[1]!
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    messages.push(createAssistantMessage({ content: [{ type: 'tool_use', id: 'sent-user-reply', name: 'SendMessage', input: { to: 'user', message: 'Already sent.' } }] }))
    messages.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'sent-user-reply', content: 'sent' }] }))
    await consumer.completeTurn(turn.uuid)
    expect(await readMailbox('user', 'sdk-team')).toHaveLength(0)
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === 'human-tool-reply')?.read).toBe(true)
  })

  test('keeps an unconfirmed human turn pending and observes later evidence without another submission', async () => {
    const consumer = await readyRuntime()
    await writeToMailbox('worker', { messageId: 'human-pending', from: 'user', text: 'Wait for the real answer.', timestamp: new Date().toISOString() }, 'sdk-team')
    await consumer.poll()
    const turn = submitted[1]!
    await consumer.beforeTurn(turn.uuid)
    messages.push(createUserMessage({ content: turn.prompt, uuid: turn.uuid }))
    await consumer.completeTurn(turn.uuid)
    await consumer.poll()
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === 'human-pending')?.read).toBe(false)
    expect(submitted).toHaveLength(2)
    messages.push(createAssistantMessage({ content: 'The actual answer arrived.' }))
    await consumer.poll()
    expect((await readMailbox('user', 'sdk-team'))[0]?.text).toBe('The actual answer arrived.')
    expect((await readMailbox('worker', 'sdk-team')).find(message => message.messageId === 'human-pending')?.read).toBe(true)
    expect(submitted).toHaveLength(2)
  })

  test('publishes real attachment-root readiness and actual query-guard generations', async () => {
    const attachments = join(root, 'attachments')
    await mkdir(attachments)
    process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT = attachments
    const consumer = runtime()
    await consumer.publishReady()
    const capabilityPath = buildWorkSyncAdmissionCapabilityPath({ teamName: 'sdk-team', memberName: 'worker' })
    const initial = JSON.parse(await readFile(capabilityPath, 'utf8'))
    expect(initial).toMatchObject({ recoveryProtocolVersion: 2, generation: 0, processorReady: true, pid: process.pid, nativeInboxAttachmentsVersion: 2 })
    expect(typeof initial.runtimeInstanceId).toBe('string')
    expect(initial.runtimeInstanceId.length).toBeGreaterThan(0)
    await consumer.poll()
    const bootstrap = submitted[0]!
    await consumer.beforeTurn(bootstrap.uuid)
    const running = JSON.parse(await readFile(capabilityPath, 'utf8'))
    expect(running.runtimeInstanceId).toBe(initial.runtimeInstanceId)
    expect(running.generation).toBe(1)
    await expect(consumer.beforeTurn(bootstrap.uuid)).rejects.toThrow('query guard rejected')
    await consumer.releaseTurn()
    const released = JSON.parse(await readFile(capabilityPath, 'utf8'))
    expect(released.runtimeInstanceId).toBe(initial.runtimeInstanceId)
    expect(released.generation).toBe(1)
    expect((await readTeammateRuntimeEvents(eventsPath)).some(event => event.type === 'bootstrap_confirmed')).toBe(false)
  })

  test('does not advertise attachment readiness for an invalid root', async () => {
    process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT = 'relative-unowned-root'
    const consumer = runtime()
    await consumer.publishReady()
    const capability = JSON.parse(await readFile(buildWorkSyncAdmissionCapabilityPath({ teamName: 'sdk-team', memberName: 'worker' }), 'utf8'))
    expect(capability.nativeInboxAttachmentsVersion).toBeUndefined()
  })

  test('requires actual private-turn output, then consumes later lead messages once', async () => {
    const consumer = runtime()
    await consumer.publishReady()
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    expect((await readTeammateRuntimeEvents(eventsPath)).some(event => event.type === 'bootstrap_confirmed')).toBe(false)
    const bootstrap = submitted[0]!
    expect(await consumer.beforeTurn(bootstrap.uuid)).toBe(true)
    expect(messages).toHaveLength(1)
    const prefix = messages[0]!
    expect(JSON.stringify(prefix)).toContain('Assigned work from the real startup handoff')
    expect(JSON.stringify(prefix)).not.toContain('test-proof')
    messages.push(createUserMessage({ content: bootstrap.prompt, uuid: bootstrap.uuid }))
    messages.push(createAssistantMessage({ content: [{ type: 'text', text: 'Startup context loaded.' }] }))
    await consumer.completeTurn(bootstrap.uuid)
    const proof = (await readTeammateRuntimeEvents(eventsPath)).find(event => event.type === 'bootstrap_confirmed')
    expect(proof).toMatchObject({ source: NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE, runId: 'launch-run', bootstrapProofToken: 'test-proof', bootstrapMirrorId: 'bootstrap-row', pid: process.pid })
    expect((await readMailbox('worker', 'sdk-team'))[0]?.read).toBe(true)
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    await writeToMailbox('worker', { messageId: 'later-task', from: 'team-lead', text: 'Execute the next assigned task', timestamp: new Date().toISOString() }, 'sdk-team')
    await consumer.poll()
    const later = submitted[1]!
    expect(later.prompt).toContain('Execute the next assigned task')
    expect(await consumer.beforeTurn(later.uuid)).toBe(false)
    messages.push(createUserMessage({ content: later.prompt, uuid: later.uuid }))
    messages.push(createAssistantMessage({ content: [{ type: 'text', text: 'Task processed.' }] }))
    await consumer.completeTurn(later.uuid)
    await consumer.poll()
    expect(submitted).toHaveLength(2)
    expect((await readMailbox('worker', 'sdk-team')).every(message => message.read)).toBe(true)
  })

  test('empty bootstrap output cannot produce readiness proof or admit later work', async () => {
    const consumer = runtime()
    await consumer.poll()
    const bootstrap = submitted[0]!
    await consumer.beforeTurn(bootstrap.uuid)
    messages.push(createUserMessage({ content: bootstrap.prompt, uuid: bootstrap.uuid }))
    messages.push(createAssistantMessage({ content: [{ type: 'text', text: '(no content)' }] }))
    await expect(consumer.completeTurn(bootstrap.uuid)).rejects.toThrow('Native bootstrap private turn failed')
    await consumer.poll()
    expect(submitted).toHaveLength(1)
    expect((await readMailbox('worker', 'sdk-team'))[0]?.read).toBe(false)
    expect((await readTeammateRuntimeEvents(eventsPath)).some(event => event.type === 'bootstrap_confirmed')).toBe(false)
  })
})
