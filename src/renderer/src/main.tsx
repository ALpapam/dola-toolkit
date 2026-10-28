import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installHostBridge } from './modHost/bridge'
import { APP_VERSION } from '@shared/version'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/pages.css'

// must run before any mod can be mounted
installHostBridge(APP_VERSION)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
