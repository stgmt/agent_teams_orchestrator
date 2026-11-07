import type { OpenCodeModelRouteMetadata } from '../opencode/OpenCodeModelRouteTypes.js'
import type { OpenCodeV2ReadStatus } from '../opencode/catalog/OpenCodeV2ReadStatus.js'

export type RuntimeProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode'

export type AnthropicRuntimeBackendId =
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'claude-platform-aws'
  | 'ollama'
  | 'anthropic-compatible'
export type GeminiRuntimeBackendId = 'auto' | 'api' | 'cli-sdk'
export type CodexRuntimeBackendId = 'codex-native'
export type RuntimeBackendId =
  | AnthropicRuntimeBackendId
  | GeminiRuntimeBackendId
  | CodexRuntimeBackendId

export type RuntimeCapabilityInfo = {
  id: string
  label: string
  enabled: boolean
}

export type RuntimeExtensionCapabilityStatus =
  | 'supported'
  | 'read-only'
  | 'unsupported'

export type RuntimeExtensionOwnership = 'shared' | 'provider-scoped'

export type RuntimeExtensionCapability = {
  status: RuntimeExtensionCapabilityStatus
  ownership: RuntimeExtensionOwnership
  reason: string | null
}

export type RuntimeExtensionCapabilities = {
  plugins: RuntimeExtensionCapability
  mcp: RuntimeExtensionCapability
  skills: RuntimeExtensionCapability
  apiKeys: RuntimeExtensionCapability
}

export type RuntimeBackendOptionState =
  | 'ready'
  | 'locked'
  | 'disabled'
  | 'authentication-required'
  | 'runtime-missing'
  | 'degraded'

export type RuntimeBackendOptionAudience = 'general' | 'internal'

export type RuntimeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export type RuntimeProviderModelCatalogSource =
  | 'anthropic-models-api'
  | 'anthropic-compatible-api'
  | 'app-server'
  | 'static-fallback'
  | 'runtime'

export type RuntimeProviderModelCatalogStatus =
  | 'ready'
  | 'stale'
  | 'degraded'
  | 'unavailable'

export type RuntimeProviderModelCatalogItem = {
  id: string
  launchModel: string
  displayName: string
  hidden: boolean
  supportedReasoningEfforts: RuntimeReasoningEffort[]
  defaultReasoningEffort: RuntimeReasoningEffort | null
  supportsFastMode?: boolean
  inputModalities: string[]
  supportsPersonality: boolean
  isDefault: boolean
  upgrade: boolean
  source: RuntimeProviderModelCatalogSource
  badgeLabel?: string | null
  statusMessage?: string | null
  metadata?: {
    cost?: unknown | null
    context?: number | null
    limits?: unknown | null
    free?: boolean
    releaseDate?: string | null
    recentlyReleased?: boolean
    opencode?: OpenCodeModelRouteMetadata | null
  } | null
}

export type RuntimeProviderModelCatalog = {
  schemaVersion: 1
  providerId: RuntimeProviderId
  source: RuntimeProviderModelCatalogSource
  status: RuntimeProviderModelCatalogStatus
  fetchedAt: string
  staleAt: string
  defaultModelId: string | null
  defaultLaunchModel: string | null
  models: RuntimeProviderModelCatalogItem[]
  diagnostics: {
    configReadState: 'ready' | 'unsupported' | 'failed' | 'skipped'
    appServerState: 'healthy' | 'degraded' | 'runtime-missing' | 'incompatible'
    message?: string | null
    code?: string | null
  }
}

export type RuntimeProviderCapabilities = {
  modelCatalog?: {
    dynamic: boolean
    source: RuntimeProviderModelCatalogSource
  }
  reasoningEffort?: {
    supported: boolean
    values: RuntimeReasoningEffort[]
    configPassthrough: boolean
  }
  fastMode?: {
    supported: boolean
    available: boolean
    reason: string | null
    source: 'runtime'
  }
}

export type RuntimeProviderSubscriptionRateLimitWindow = {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export type RuntimeProviderSubscriptionRateLimitSnapshot = {
  primary: RuntimeProviderSubscriptionRateLimitWindow | null
  secondary: RuntimeProviderSubscriptionRateLimitWindow | null
}

export type RuntimeBackendOptionStatus = {
  id: RuntimeBackendId
  label: string
  description: string
  selectable: boolean
  recommended: boolean
  available: boolean
  state: RuntimeBackendOptionState
  audience: RuntimeBackendOptionAudience
  statusMessage: string | null
  detailMessage: string | null
}

export type ExternalRuntimeDiagnostic = {
  id: 'cli-bin'
  label: string
  detected: boolean
  statusMessage: string | null
  detailMessage: string | null
}

export type RuntimeStatusCheckOutcome =
  | 'authoritative'
  | 'pending'
  | 'transient_error'
  | 'model_only'

export type RuntimeStatusCheckErrorCode =
  | 'timeout'
  | 'unavailable'
  | 'runtime_missing'
  | 'partial_response'

export type RuntimeProviderStatus = {
  openCodeReadStatus?: OpenCodeV2ReadStatus
  providerId: RuntimeProviderId
  displayName: string
  supported: boolean
  authenticated: boolean
  authMethod: string | null
  verificationState: 'verified' | 'unknown' | 'offline' | 'error'
  canLoginFromUi: boolean
  capabilities: {
    teamLaunch: boolean
    oneShot: boolean
    extensions: RuntimeExtensionCapabilities
  }
  statusMessage: string | null
  detailMessage: string | null
  selectedBackendId: RuntimeBackendId | null
  resolvedBackendId: RuntimeBackendId | null
  availableBackends: RuntimeBackendOptionStatus[]
  externalRuntimeDiagnostics: ExternalRuntimeDiagnostic[]
  models: string[]
  /** Current inherited team model resolved from applied runtime config; null means unknown. */
  effectiveDefaultModel?: string | null
  modelCatalog?: RuntimeProviderModelCatalog | null
  runtimeCapabilities?: RuntimeProviderCapabilities
  subscriptionRateLimits?: RuntimeProviderSubscriptionRateLimitSnapshot | null
  backend: {
    kind: string
    label: string
    endpointLabel?: string | null
    projectId?: string | null
    authMethodDetail?: string | null
  } | null
  capabilitiesInfo?: RuntimeCapabilityInfo[]
  /** Additive wire contract; consumers must treat missing legacy values conservatively. */
  statusCheckOutcome?: RuntimeStatusCheckOutcome
  statusCheckErrorCode?: RuntimeStatusCheckErrorCode | null
  /** Explicit source of Anthropic status-check degradation, not launch authorization. */
  statusCheckSource?: {
    schemaVersion: 1
    cause: 'none' | 'catalog' | 'connection'
  }
}

export type RuntimeStatusPayload = {
  schemaVersion: 2
  providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>>
}

export type RuntimeStatusDetailLevel = 'full' | 'summary'
