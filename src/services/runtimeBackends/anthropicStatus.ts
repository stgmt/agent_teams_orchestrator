import type {
  AnthropicRuntimeBackendId,
  RuntimeExtensionCapabilities,
  RuntimeProviderCapabilities,
  RuntimeProviderModelCatalog,
  RuntimeProviderSubscriptionRateLimitSnapshot,
  RuntimeProviderStatus,
  RuntimeStatusCheckErrorCode,
  RuntimeStatusCheckOutcome,
} from './types.js'

type AnthropicAuthenticatedState = {
  authenticated: boolean
  authMethod: string | null
}

export type AnthropicRuntimeBackendInfo = {
  id: AnthropicRuntimeBackendId
  label: string
  endpointLabel: string | null
  projectId?: string | null
  authenticated?: boolean
  authMethodDetail: string | null
  statusMessage: string
  detailMessage: string | null
}

export function isAnthropicSubscriptionAuthMethod(
  authMethod: string | null | undefined,
): boolean {
  return authMethod === 'claude.ai' || authMethod === 'oauth_token'
}

export function buildAnthropicRuntimeStatus(params: {
  effectiveDefaultModel?: string | null
  auth: AnthropicAuthenticatedState
  modelCatalog: RuntimeProviderModelCatalog
  visibleModels: string[]
  reasoningEfforts: NonNullable<RuntimeProviderCapabilities['reasoningEffort']>['values']
  fastMode: NonNullable<RuntimeProviderCapabilities['fastMode']>
  extensions: RuntimeExtensionCapabilities
  subscriptionRateLimits?: RuntimeProviderSubscriptionRateLimitSnapshot | null
  backend?: AnthropicRuntimeBackendInfo | null
}): RuntimeProviderStatus {
  const backend = params.backend ?? null
  const statusCheck = getAnthropicStatusCheckContract(
    params.modelCatalog.status,
    backend,
  )
  const compatibleBackendVerified =
    (backend?.id === 'ollama' || backend?.id === 'anthropic-compatible') &&
    params.auth.authenticated &&
    params.modelCatalog.source === 'anthropic-compatible-api' &&
    params.modelCatalog.status === 'ready' &&
    params.modelCatalog.models.length > 0
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: params.auth.authenticated,
    authMethod: params.auth.authMethod,
    verificationState: compatibleBackendVerified || !backend ? 'verified' : 'unknown',
    canLoginFromUi: backend ? false : true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: params.extensions,
    },
    statusMessage: backend
      ? backend.statusMessage
      : params.auth.authenticated
        ? null
        : 'Not connected',
    detailMessage: backend?.detailMessage ?? null,
    selectedBackendId: backend?.id ?? null,
    resolvedBackendId: backend?.id ?? null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: params.visibleModels,
    effectiveDefaultModel: params.effectiveDefaultModel ?? null,
    modelCatalog: params.modelCatalog,
    subscriptionRateLimits: isAnthropicSubscriptionAuthMethod(params.auth.authMethod)
      ? (params.subscriptionRateLimits ?? null)
      : null,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: params.modelCatalog.source,
      },
      reasoningEffort: {
        supported: params.reasoningEfforts.length > 0,
        values: params.reasoningEfforts,
        configPassthrough: true,
      },
      fastMode: params.fastMode,
    },
    backend: backend
      ? {
          kind: backend.id,
          label: backend.label,
          endpointLabel: backend.endpointLabel,
          projectId: backend.projectId ?? null,
          authMethodDetail: backend.authMethodDetail,
        }
      : null,
    ...statusCheck,
  }
}

export function getAnthropicStatusCheckContract(
  catalogStatus: RuntimeProviderModelCatalog['status'] | null,
  backend: AnthropicRuntimeBackendInfo | null,
): {
  statusCheckOutcome: RuntimeStatusCheckOutcome
  statusCheckErrorCode: RuntimeStatusCheckErrorCode | null
  statusCheckSource: { schemaVersion: 1; cause: 'none' | 'catalog' | 'connection' }
} {
  if (
    backend?.authMethodDetail?.includes('transport_unavailable') ||
    backend?.authMethodDetail?.includes('configuration_incomplete')
  ) {
    return {
      statusCheckOutcome: 'transient_error',
      statusCheckSource: { schemaVersion: 1, cause: 'connection' },
      statusCheckErrorCode: 'unavailable',
    }
  }
  if (catalogStatus === 'unavailable') {
    return {
      statusCheckOutcome: 'transient_error',
      statusCheckSource: { schemaVersion: 1, cause: 'catalog' },
      statusCheckErrorCode: 'unavailable',
    }
  }
  if (catalogStatus === 'stale' || catalogStatus === 'degraded') {
    return {
      statusCheckOutcome: 'pending',
      statusCheckSource: { schemaVersion: 1, cause: 'catalog' },
      statusCheckErrorCode: 'partial_response',
    }
  }
  return {
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: null,
    statusCheckSource: { schemaVersion: 1, cause: 'none' },
  }
}
