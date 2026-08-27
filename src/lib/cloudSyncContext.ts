import { createContext, useContext } from 'react'

export type CloudSyncStatus = 'sincronizado' | 'salvando' | 'baixando' | 'offline'

export type CloudSyncContextValue = {
  status: CloudSyncStatus
  error: string | null
  /** true só quando a última comunicação com a nuvem foi ok */
  cloudOk: boolean
  mode: 'admin' | 'member'
  /** Tenta de novo agora, sem recarregar a página (recarregar apagaria venda offline). */
  retry: () => void
}

export const CloudSyncContext = createContext<CloudSyncContextValue>({
  status: 'baixando',
  error: null,
  cloudOk: false,
  mode: 'member',
  retry: () => {},
})

export function useCloudSync() {
  return useContext(CloudSyncContext)
}
