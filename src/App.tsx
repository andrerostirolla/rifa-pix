import { useCallback, useState } from 'react'
import { isAuthenticated, logout as localLogout } from './auth'
import CloudApp from './CloudApp'
import { CloudWorkspaceBridge } from './CloudWorkspaceBridge'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import { loadCloudSession, saveCloudSession } from './lib/workspace'
import LocalApp from './LocalApp'
import { LoginScreen } from './LoginScreen'

const LEGACY_CLOUD = import.meta.env.VITE_LEGACY_CLOUD_APP === '1'

export default function App() {
  const auth = useAuth()
  const [authed, setAuthed] = useState(() => isAuthenticated())
  const [cloudError, setCloudError] = useState<string | null>(null)

  const onReady = useCallback(() => {
    setCloudError(null)
    setAuthed(true)
  }, [])

  const onCloudError = useCallback((msg: string) => {
    setCloudError(msg)
  }, [])

  if (isSupabaseConfigured) {
    if (auth.loading) {
      return (
        <div className="auth-shell">
          <div className="auth-card panel">
            <p className="brand">RifaPIX</p>
            <p className="hint">Carregando…</p>
          </div>
        </div>
      )
    }

    if (LEGACY_CLOUD && auth.user) return <CloudApp />

    const cloudSession = loadCloudSession()
    const canEnter = isAuthenticated() || authed

    if (auth.user && canEnter) {
      if (!cloudSession || cloudSession.role !== 'admin') {
        saveCloudSession({
          role: 'admin',
          workspace: {
            id: cloudSession?.workspace.id || '',
            name: auth.user.user_metadata?.organizer_name || auth.user.email || 'RifaPIX',
            accessCode: cloudSession?.workspace.accessCode || '',
            updatedAt: cloudSession?.workspace.updatedAt || new Date().toISOString(),
          },
        })
      }
      return (
        <CloudWorkspaceBridge mode="admin" onReady={onReady} onError={onCloudError}>
          {cloudError ? (
            <div className="auth-shell">
              <div className="auth-card panel">
                <p className="brand">RifaPIX</p>
                <p className="auth-error">{cloudError}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    await auth.signOut()
                    saveCloudSession(null)
                    localLogout()
                    setAuthed(false)
                    window.location.reload()
                  }}
                >
                  Sair e tentar de novo
                </button>
              </div>
            </div>
          ) : (
            <LocalApp />
          )}
        </CloudWorkspaceBridge>
      )
    }

    if (cloudSession?.role === 'member' && canEnter) {
      return (
        <CloudWorkspaceBridge mode="member" onReady={onReady} onError={onCloudError}>
          {cloudError ? (
            <div className="auth-shell">
              <div className="auth-card panel">
                <p className="brand">RifaPIX</p>
                <p className="auth-error">{cloudError}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    saveCloudSession(null)
                    localLogout()
                    setAuthed(false)
                    window.location.reload()
                  }}
                >
                  Sair e tentar de novo
                </button>
              </div>
            </div>
          ) : (
            <LocalApp />
          )}
        </CloudWorkspaceBridge>
      )
    }

    return <LoginScreen onLocalAuthenticated={() => setAuthed(true)} />
  }

  if (!authed) return <LoginScreen onLocalAuthenticated={() => setAuthed(true)} />
  return <LocalApp />
}
