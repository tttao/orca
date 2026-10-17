import { Suspense, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { installStandalonePreloadApi } from './web-standalone-preload-api'
import { I18nProvider } from '../i18n/I18nProvider'

const App = lazy(() => import('../App'))

function WebRoot(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    installStandalonePreloadApi().then(() => setReady(true))
  }, [])
  if (!ready) {
    return <div className="min-h-dvh bg-background" />
  }
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" />}>
      <App />
    </Suspense>
  )
}

function WebRootBoundary(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="web.standalone.root"
      surface="web-standalone-root"
      title="Orca web IDE hit a renderer error."
      description="Refresh the web client or reconnect to the server."
    >
      <WebRoot />
    </RecoverableRenderErrorBoundary>
  )
}

// Prime the terminal WebGL addon off the boot graph, mirroring web/main.tsx.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <I18nProvider>
    <WebRootBoundary />
  </I18nProvider>
)
