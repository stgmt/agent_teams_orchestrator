import { useRef } from 'react'
import {
  createNativeAppManagedBootstrapContextInjection,
  type GetNativeAppManagedBootstrapContextInjection,
} from '../services/teamBootstrap/nativeAppManagedBootstrapContext.js'

export type {
  GetNativeAppManagedBootstrapContextInjection,
  NativeAppManagedBootstrapTurnInjection,
} from '../services/teamBootstrap/nativeAppManagedBootstrapContext.js'

export function useNativeAppManagedBootstrapContextInjection(): {
  getNativeAppManagedBootstrapContextInjection: GetNativeAppManagedBootstrapContextInjection
} {
  const getter = useRef<GetNativeAppManagedBootstrapContextInjection | null>(null)
  getter.current ??= createNativeAppManagedBootstrapContextInjection()
  return { getNativeAppManagedBootstrapContextInjection: getter.current }
}
