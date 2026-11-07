import { describe, expect, test } from 'bun:test'

import { buildCodexNativeLaunchConfigOverrides } from './launchConfigOverrides.js'

function withSpecRegistryUrl<T>(url: string | undefined, callback: () => T): T {
  const previous = process.env.OMP_SPEC_REGISTRY_URL
  if (url === undefined) {
    delete process.env.OMP_SPEC_REGISTRY_URL
  } else {
    process.env.OMP_SPEC_REGISTRY_URL = url
  }
  try {
    return callback()
  } finally {
    if (previous === undefined) {
      delete process.env.OMP_SPEC_REGISTRY_URL
    } else {
      process.env.OMP_SPEC_REGISTRY_URL = previous
    }
  }
}

describe('Codex native launch config overrides', () => {
  test('reads safe app-owned launch overrides and ignores legacy flex from settings', () => {
    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: [
                'service_tier="flex"',
                'service_tier="fast"',
                'features.fast_mode=true',
                'forced_login_method="api"',
                'service_tier="fast"',
              ],
            },
          },
        },
      }),
    ).toEqual(['service_tier="fast"', 'features.fast_mode=true'])
  })

  test('passes only the validated app registry URL and bearer environment name', () => {
    const registryUrl = 'http://127.0.0.1:8650/mcp'
    const tokenEnvOverride =
      'mcp_servers.omp-spec-kit.bearer_token_env_var="OMP_SPEC_REGISTRY_TOKEN"'
    withSpecRegistryUrl(registryUrl, () => {
      const overrides = buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: [
                'service_tier="fast"',
                'features.fast_mode=true',
                `mcp_servers.omp-spec-kit.url=${JSON.stringify(registryUrl)}`,
                tokenEnvOverride,
                'mcp_servers.other.url="https://attacker.example/mcp"',
                'mcp_servers.omp-spec-kit.headers.Authorization="Bearer TEST-registry-token"',
                'model="gpt-5"',
              ],
            },
          },
        },
      })

      expect(overrides).toEqual([
        'service_tier="fast"',
        'features.fast_mode=true',
        `mcp_servers.omp-spec-kit.url=${JSON.stringify(registryUrl)}`,
        tokenEnvOverride,
      ])
      expect(overrides.join(' ')).not.toContain('TEST-registry-token')
    })
  })

  test('validates the registry endpoint before forwarding its overrides', () => {
    const registryUrl = 'https://registry.example.invalid/mcp'
    const tokenEnvOverride =
      'mcp_servers.omp-spec-kit.bearer_token_env_var="OMP_SPEC_REGISTRY_TOKEN"'
    const configOverrides = [
      `mcp_servers.omp-spec-kit.url=${JSON.stringify(registryUrl)}`,
      tokenEnvOverride,
    ]
    const settingsInline = {
      codex: { agent_teams_launch_config: { config_overrides: configOverrides } },
    }

    withSpecRegistryUrl(registryUrl, () => {
      configOverrides[0] =
        'mcp_servers.omp-spec-kit.url="HTTPS://REGISTRY.EXAMPLE.INVALID:443/mcp"'
      expect(buildCodexNativeLaunchConfigOverrides({ settingsInline })).toEqual([
        `mcp_servers.omp-spec-kit.url=${JSON.stringify(registryUrl)}`,
        tokenEnvOverride,
      ])
      for (const url of [
        'http://registry.example.invalid/mcp',
        'https://user:password@registry.example.invalid/mcp',
        'https://registry.example.invalid/mcp?token=secret',
        'https://registry.example.invalid/mcp#fragment',
        'file:///tmp/spec-registry',
        'https://registry.example.invalid/mcp ',
      ]) {
        withSpecRegistryUrl(url, () => {
          configOverrides[0] = `mcp_servers.omp-spec-kit.url=${JSON.stringify(url)}`
          expect(buildCodexNativeLaunchConfigOverrides({ settingsInline })).toEqual([])
        })
      }

      configOverrides[0] = 'mcp_servers.omp-spec-kit.url="https://other.example.invalid/mcp"'
      expect(buildCodexNativeLaunchConfigOverrides({ settingsInline })).toEqual([])
    })
  })

  test('requires exactly one safe URL and the exact token environment reference', () => {
    const registryUrl = 'mcp_servers.omp-spec-kit.url="http://127.0.0.1:8650/mcp"'
    const tokenEnvOverride =
      'mcp_servers.omp-spec-kit.bearer_token_env_var="OMP_SPEC_REGISTRY_TOKEN"'
    withSpecRegistryUrl('http://127.0.0.1:8650/mcp', () => {
      for (const configOverrides of [
        [registryUrl],
        [tokenEnvOverride],
        [
          registryUrl,
          tokenEnvOverride,
          'mcp_servers.omp-spec-kit.url="https://other.example.invalid/mcp"',
        ],
        [registryUrl, 'mcp_servers.omp-spec-kit.bearer_token_env_var="TEST-secret-token"'],
        [],
      ]) {
        expect(
          buildCodexNativeLaunchConfigOverrides({
            settingsInline: {
              codex: {
                agent_teams_launch_config: { config_overrides: configOverrides },
              },
            },
          }),
        ).toEqual([])
      }
    })

    withSpecRegistryUrl(undefined, () => {
      expect(
        buildCodexNativeLaunchConfigOverrides({
          settingsInline: {
            codex: {
              agent_teams_launch_config: {
                config_overrides: [
                  registryUrl,
                  tokenEnvOverride,
                ],
              },
            },
          },
        }),
      ).toEqual([])
    })
  })


  test('ignores malformed settings', () => {
    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: 'service_tier="fast"',
            },
          },
        },
      }),
    ).toEqual([])
  })

  test('ignores incomplete fast mode overrides', () => {
    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: ['service_tier="fast"'],
            },
          },
        },
      }),
    ).toEqual([])

    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: ['features.fast_mode=true'],
            },
          },
        },
      }),
    ).toEqual([])
  })
})
