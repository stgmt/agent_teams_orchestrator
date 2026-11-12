import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { SdkOutputEntry } from '../types/logs.js'
import { isEnvTruthy } from './envUtils.js'

export interface SdkOutputPersistenceOwner {
  /** The canonical session writer returns undefined only when host policy disables persistence. */
  recordFrame(message: SdkOutputEntry['message']): Promise<string | undefined>
}

/** Launch-level opt-outs shared with the canonical host persistence policy. */
export function isSessionOutputPersistenceDisabledByLaunch(): boolean {
  return (
    ((process.env.NODE_ENV || 'development') === 'test' &&
      !isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)) ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
  )
}

export async function persistSdkOutputFrame(
  message: SdkOutputEntry['message'],
  owner?: SdkOutputPersistenceOwner,
): Promise<string | undefined> {
  if (owner) return owner.recordFrame(message)
  if (isSessionOutputPersistenceDisabledByLaunch()) return undefined
  // Missing composition must never silently turn a persistent session into a
  // memory-only session. Settings-based opt-outs belong to the supplied owner.
  throw new Error('SDK output persistence requires the canonical session owner')
}

/** Stream complete SDK frames without loading a potentially multi-GB session. */
export async function* readSdkOutputFrames(
  transcriptPath: string,
): AsyncGenerator<SdkOutputEntry['message']> {
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Project owns this compact prefix. Ignore conversation/metadata lines
      // before parsing, including a concurrent writer's partial metadata tail.
      if (!line.startsWith('{"type":"sdk-output",')) continue
      const entry: SdkOutputEntry = JSON.parse(line)
      if (entry.type === 'sdk-output') yield entry.message
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}
