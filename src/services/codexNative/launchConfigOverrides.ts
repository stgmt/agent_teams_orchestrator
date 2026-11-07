import { getFlagSettingsInline } from '../../bootstrap/state.js'

const LAUNCH_CONFIG_SETTINGS_KEY = 'agent_teams_launch_config'
const CONFIG_OVERRIDES_KEY = 'config_overrides'
const FAST_SERVICE_TIER_OVERRIDE = 'service_tier="fast"'
const FAST_MODE_FEATURE_OVERRIDE = 'features.fast_mode=true'

const SPEC_REGISTRY_MCP_SERVER = 'omp-spec-kit'
const SPEC_REGISTRY_TOKEN_ENV = 'OMP_SPEC_REGISTRY_TOKEN'
const SPEC_REGISTRY_URL_ENV = 'OMP_SPEC_REGISTRY_URL'
const SPEC_REGISTRY_URL_OVERRIDE_PREFIX = `mcp_servers.${SPEC_REGISTRY_MCP_SERVER}.url=`
const SPEC_REGISTRY_TOKEN_ENV_OVERRIDE_PREFIX =
  `mcp_servers.${SPEC_REGISTRY_MCP_SERVER}.bearer_token_env_var=`
const SPEC_REGISTRY_TOKEN_ENV_OVERRIDE =
  `${SPEC_REGISTRY_TOKEN_ENV_OVERRIDE_PREFIX}${JSON.stringify(SPEC_REGISTRY_TOKEN_ENV)}`
const HTTP_LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getLaunchConfigSettings(
  settingsInline: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const codexSettings = asRecord(settingsInline?.codex)
  return asRecord(codexSettings?.[LAUNCH_CONFIG_SETTINGS_KEY])
}

function parseJsonStringLiteral(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function resolveAllowedSpecRegistryUrl(value: string): string | null {
  if (!value || value.trim() !== value) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === 'http:' && !HTTP_LOOPBACK_HOSTNAMES.has(url.hostname))
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export function buildCodexNativeLaunchConfigOverrides(params?: {
  settingsInline?: Record<string, unknown> | null
}): string[] {
  const settingsInline = params?.settingsInline ?? getFlagSettingsInline()
  const launchConfigSettings = getLaunchConfigSettings(settingsInline)
  const rawOverrides = launchConfigSettings?.[CONFIG_OVERRIDES_KEY]
  if (!Array.isArray(rawOverrides)) {
    return []
  }

  const authoritativeSpecRegistryUrl = resolveAllowedSpecRegistryUrl(
    process.env[SPEC_REGISTRY_URL_ENV] ?? '',
  )
  let hasFastServiceTier = false
  let hasFastModeFeature = false
  let specRegistryUrlOverrideCount = 0
  let specRegistryTokenEnvOverrideCount = 0
  let specRegistryUrl: string | null = null
  let hasSpecRegistryTokenEnvOverride = false
  for (const rawOverride of rawOverrides) {
    if (typeof rawOverride !== 'string') {
      continue
    }
    if (rawOverride === FAST_SERVICE_TIER_OVERRIDE) {
      hasFastServiceTier = true
    }
    if (rawOverride === FAST_MODE_FEATURE_OVERRIDE) {
      hasFastModeFeature = true
    }
    if (rawOverride.startsWith(SPEC_REGISTRY_URL_OVERRIDE_PREFIX)) {
      specRegistryUrlOverrideCount += 1
      const candidate = parseJsonStringLiteral(
        rawOverride.slice(SPEC_REGISTRY_URL_OVERRIDE_PREFIX.length),
      )
      specRegistryUrl = candidate ? resolveAllowedSpecRegistryUrl(candidate) : null
    }
    if (rawOverride.startsWith(SPEC_REGISTRY_TOKEN_ENV_OVERRIDE_PREFIX)) {
      specRegistryTokenEnvOverrideCount += 1
      hasSpecRegistryTokenEnvOverride ||= rawOverride === SPEC_REGISTRY_TOKEN_ENV_OVERRIDE
    }
  }

  const overrides: string[] =
    hasFastServiceTier && hasFastModeFeature
      ? [FAST_SERVICE_TIER_OVERRIDE, FAST_MODE_FEATURE_OVERRIDE]
      : []
  if (
    specRegistryUrlOverrideCount === 1 &&
    specRegistryUrl &&
    specRegistryUrl === authoritativeSpecRegistryUrl &&
    specRegistryTokenEnvOverrideCount === 1 &&
    hasSpecRegistryTokenEnvOverride
  ) {
    overrides.push(
      `${SPEC_REGISTRY_URL_OVERRIDE_PREFIX}${JSON.stringify(specRegistryUrl)}`,
      SPEC_REGISTRY_TOKEN_ENV_OVERRIDE,
    )
  }
  return overrides
}
