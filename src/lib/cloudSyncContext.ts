import { createContext, useContext } from 'react'

export type CloudSyncStatus = 'sincronizado' | 'salvando' | 'baixando' | 'offline'

export type CloudSyncContextValue = {
  status: CloudSyncStatus
  error: string | null
  /** true só quando a última comunicação com a nuvem foi ok */
  cloudOk: boolean
}

export const CloudSyncContext = createContext<CloudSyncContextValue>({
  status: 'baixando',
  error: null,
  cloudOk: false,
})

export function useCloudSync() {
  return useContext(CloudSyncContext)
}
