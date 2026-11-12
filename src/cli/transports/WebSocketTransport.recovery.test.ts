import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { once } from 'events'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { WebSocketTransport } from './WebSocketTransport.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  loadTranscriptFile,
  recordTranscript,
  recordSdkOutputFrame,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { createUserMessage } from '../../utils/messages.js'

describe('Node SDK upgrade recovery', () => {
  let root: string
  let moduleUrl: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sdk-node-transport-'))
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./WebSocketTransport.ts', import.meta.url))],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      splitting: false,
      // Child launch policy must be evaluated in Node, not frozen from bun test.
      env: 'disable',
      // Match the shipped build's external-user DCE; internal namespace source
      // is intentionally absent from this reconstructed runtime checkout.
      minify: true,
      define: {
        'process.env.USER_TYPE': JSON.stringify('external'),
        'MACRO.VERSION': JSON.stringify('2.1.251'),
        'MACRO.CLIENT_VERSION': JSON.stringify('2.777.777'),
        'MACRO.RUNTIME_VERSION': JSON.stringify('0.0.158'),
        'MACRO.BUILD_TIME': JSON.stringify('test'),
        'MACRO.PACKAGE_URL': JSON.stringify('claude-multimodel'),
        'MACRO.NATIVE_PACKAGE_URL': 'undefined',
        'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
        'MACRO.ISSUES_EXPLAINER': JSON.stringify('External runtime test'),
        'MACRO.VERSION_CHANGELOG': JSON.stringify('test'),
        PACKAGED_OPENCODE_DELIVERY: 'undefined',
        OPENCODE_V2_DELIVERY_DESCRIPTOR: 'undefined',
        OPENCODE_RUNTIME_SOURCE_COMMIT: 'undefined',
        OPENCODE_RUNTIME_VERSION: JSON.stringify('0.0.158'),
        OPENCODE_V2_DELIVERED: 'true',
      },
      external: ['@ant/*', 'audio-capture-napi', 'image-processor-napi', 'keytar', 'modifiers-napi', 'url-handler-napi'],
    })
    const entry = built.outputs.find(output => output.kind === 'entry-point')
    if (!built.success || !entry) {
      throw new Error(`Node transport bundle failed: ${built.logs.map(log => log.message).join('; ')}`)
    }
    const modulePath = join(root, 'transport.mjs')
    for (const output of built.outputs) {
      const outputPath = output === entry ? modulePath : join(root, basename(output.path))
      await writeFile(outputPath, new Uint8Array(await output.arrayBuffer()))
    }
    moduleUrl = pathToFileURL(modulePath).href
  })
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  test.each([
    { cursor: '', expected: ['first', 'second'] },
    { cursor: 'first', expected: ['second'] },
    { cursor: 'not-retained', expected: ['first', 'second'] },
  ])('replays pending frames with upgrade cursor "$cursor"', async ({ cursor, expected }) => {
    // Both endpoints run under Node: Bun replaces bare `ws` imports with its
    // own compatibility layer, whose server is not the Node upgrade authority.
    const script = `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import { WebSocketServer } from 'ws';
      import { WebSocketTransport } from ${JSON.stringify(moduleUrl)};
      assert.equal(typeof Bun, 'undefined');
      const cursor = ${JSON.stringify(cursor)};
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      const received = [];
      const barrier = Promise.withResolvers();
      let upgrades = 0;
      let client;
      server.on('headers', headers => {
        upgrades++;
        if (cursor) headers.push('X-Last-Request-Id: ' + cursor);
      });
      server.on('connection', socket => {
        socket.on('message', bytes => {
          const frame = JSON.parse(bytes.toString());
          if (frame.uuid === 'node-barrier') barrier.resolve();
          else received.push(frame.uuid);
        });
      });
      try {
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        client = new WebSocketTransport(new URL('ws://127.0.0.1:' + address.port + '/'));
        for (const uuid of ['first', 'second']) {
          await client.write({ type: 'control_request', request_id: 'request-' + uuid,
            request: { subtype: 'interrupt' }, uuid });
        }
        const connected = Promise.withResolvers();
        client.setOnConnect(connected.resolve);
        await client.connect();
        await connected.promise;
        await client.write({ type: 'keep_alive', uuid: 'node-barrier' });
        await barrier.promise;
        assert.equal(upgrades, 1);
        process.stdout.write(JSON.stringify(received));
      } finally {
        client?.close();
        for (const socket of server.clients) socket.terminate();
        const closed = once(server, 'close');
        server.close();
        await closed;
      }
    `
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '0', CLAUDE_CONFIG_DIR: root },
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`Node transport exited ${exitCode}: ${await new Response(child.stderr).text()}`)
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(expected)
  })

  test('persistent output fails closed without its canonical owner', async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { WebSocketTransport } from ${JSON.stringify(moduleUrl)};
      assert.equal(typeof Bun, 'undefined');
      assert.equal(process.env.NODE_ENV, 'production');
      assert.equal(process.env.TEST_ENABLE_SESSION_PERSISTENCE, '1');
      assert.equal(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '0');
      const client = new WebSocketTransport(new URL('ws://127.0.0.1/'), {}, randomUUID());
      await assert.rejects(client.write({
        type: 'control_request', request_id: 'missing-owner',
        request: { subtype: 'interrupt' }, uuid: 'missing-owner-frame',
      }), /canonical session owner/);
      assert.equal(client.isClosedStatus(), true);
    `
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0',
        CLAUDE_CONFIG_DIR: root,
      },
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`Node owner refusal exited ${exitCode}: ${await new Response(child.stderr).text()}`)
    expect(exitCode).toBe(0)
  })
})

describe('native SDK complete reconnect output', () => {
  let root: string
  let originalConfigDir: string | undefined
  let originalTestPersistence: string | undefined
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sdk-durable-replay-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
  })
  afterAll(async () => {
    await flushSessionStorage()
    resetProjectForTesting()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    await rm(root, { recursive: true, force: true })
  })
  test('retains more than 1000 events and UUID-less controls with stable replay identities', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    let client: WebSocketTransport | undefined
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test listener address')
      const received: Record<string, unknown>[][] = []
      const firstBarrier = Promise.withResolvers<void>()
      const secondBarrier = Promise.withResolvers<void>()
      server.on('connection', socket => {
        const batch: Record<string, unknown>[] = []
        received.push(batch)
        socket.on('message', bytes => {
          const frame = JSON.parse(bytes.toString())
          batch.push(frame)
          if (frame.uuid === 'first-barrier') firstBarrier.resolve()
          if (frame.uuid === 'second-barrier') secondBarrier.resolve()
        })
      })
      client = new WebSocketTransport(new URL(`ws://127.0.0.1:${address.port}/`), {}, undefined, undefined, {
        sdkOutput: { recordFrame: recordSdkOutputFrame },
      })
      const conversationMessage = createUserMessage({ content: 'Persisted conversation must remain visible exactly once.' })
      await recordTranscript([conversationMessage])
      const outputIds: string[] = []
      for (let index = 0; index < 1005; index++) {
        const uuid = randomUUID()
        outputIds.push(uuid)
        await client.write({ type: 'system', subtype: 'status', status: null, uuid, session_id: 'recovery-session' })
      }
      await client.write({
        type: 'control_request',
        request_id: 'pending-control',
        request: { subtype: 'interrupt' },
      })
      await client.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'initialize-command', response: { pid: process.pid } },
      })
      const persisted = (await readFile(getTranscriptPath(), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line))
        .filter(entry => entry.type === 'sdk-output')
      expect(persisted).toHaveLength(1007)
      expect(persisted.slice(0, 1005).map(entry => entry.message.uuid)).toEqual(outputIds)
      const restoredConversation = await loadTranscriptFile(getTranscriptPath())
      expect([...restoredConversation.messages.keys()]).toEqual([conversationMessage.uuid])
      expect(restoredConversation.messages.get(conversationMessage.uuid)?.message).toEqual(conversationMessage.message)
      const connected = Promise.withResolvers<void>()
      client.setOnConnect(connected.resolve)
      await client.connect()
      await connected.promise
      const firstMarker = { type: 'keep_alive' as const, uuid: 'first-barrier' }
      await client.write(firstMarker)
      await firstBarrier.promise
      const first = received[0]!
      // The barrier is serialized after replay on open, including disk reads.
      // This yields an immediate behavioral assertion, not a timeout oracle.
      expect(first.filter(frame => outputIds.includes(String(frame.uuid))).map(frame => frame.uuid)).toEqual(outputIds)
      const controls = first.filter(frame => frame.type === 'control_request' || frame.type === 'control_response')
      expect(controls).toHaveLength(2)
      expect(controls.every(frame => typeof frame.uuid === 'string' && frame.uuid.length > 0)).toBe(true)
      expect(controls[0]?.request_id).toBe('pending-control')
      expect(controls[1]?.response).toMatchObject({ request_id: 'initialize-command' })

      // Exercise the same surviving transport, with no new input/provider call.
      const reconnected = Promise.withResolvers<void>()
      client.setOnConnect(reconnected.resolve)
      for (const socket of server.clients) socket.close(1012, 'application restart')
      await reconnected.promise
      const secondMarker = { type: 'keep_alive' as const, uuid: 'second-barrier' }
      await client.write(secondMarker)
      await secondBarrier.promise
      const replayedControls = received[1]!.filter(frame => frame.type === 'control_request' || frame.type === 'control_response')
      expect(replayedControls).toEqual(controls)
      expect(received[1]!.filter(frame => outputIds.includes(String(frame.uuid))).map(frame => frame.uuid)).toEqual(outputIds)
    } finally {
      client?.close()
      for (const socket of server.clients) socket.terminate()
      const closed = once(server, 'close')
      server.close()
      await closed
    }
  })
})
