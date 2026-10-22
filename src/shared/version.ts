// Single source of truth for the app identity + version shown in the UI.
// Pinned in code so a dev run, an unpacked build and the portable exe all
// report the same product version (Electron's `app.getVersion()` returns the
// Electron version when the package metadata is not the one being executed).
export const APP_NAME = 'Dola Toolkit'
export const APP_NAME_CN = '多拉工具箱'
export const APP_VERSION = '0.0.2'
export const APP_VERSION_LABEL = 'beta 0.0.2'
export const APP_CHANNEL = 'beta'
export const GITHUB_REPO = 'https://github.com/ALpapam/dola-toolkit'
