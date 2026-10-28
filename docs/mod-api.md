# Dola Toolkit 插件接口

一个插件（mod）就是一个 `.zip`：根目录放 `dola-mod.json` 和入口 bundle。

## 清单 `dola-mod.json`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识，同时是安装目录名。只能包含字母、数字、`.`、`_`、`-` |
| `name` | ✅ | 侧边栏显示的名称 |
| `version` | ✅ | 形如 `1.0.0`。重新导入时按它比较：新版本覆盖，旧版本拒绝 |
| `settingsName` | | 二级设置页标题，默认「<name>设置」 |
| `createdAt` | | 创建时间（ISO 字符串），仅作展示 |
| `description` | | 首次安装时作为使用引导弹窗展示一次 |
| `icon` | | 侧边栏图标名（Material Symbols），默认 `extension` |
| `settingsIcon` | | 设置页图标名，默认 `settings` |
| `entry` | | 入口 bundle，默认 `index.js`。**扩展名必须是 `.js` 或 `.mjs`**（`dola-mod://` 只对这两个返回 `text/javascript`，`.cjs` 会被当成二进制而加载失败） |
| `backupFile` | | 想参与 WebDAV 备份的数据文件，相对 `<userData>`（如 `library/library.json`）。声明后该工具会出现在「同步内容」弹窗里，远端名为 `dola-mod-<id>.json` |

清单可以嵌套最多两层文件夹（例如 zip 里先套一个 `library/` 目录）。

`icon` / `settingsIcon` 必须是内置图标名（见 `src/renderer/src/ui/icons.generated.ts`），
写错会静默回退成 `info` 图标。默认分别是 `apps` / `tune`。

缺少清单文件时安装会被拒绝并删除，提示「这似乎不是Dola Toolkit的插件呢~」。

## 入口 bundle

入口是一个 **IIFE**，加载后向全局注册：

```js
window.__DOLA_MODS__ = window.__DOLA_MODS__ || {}
window.__DOLA_MODS__['library'] = {
  // 工具界面（可选，但至少要有 mount 或 mountSettings 之一）
  mount(container) {
    // 把 UI 渲染进 container
    return () => { /* 卸载 */ }
  },
  // 二级设置界面（可选），由「设置 → 工具 → 设置」打开
  mountSettings(container) {
    return () => { /* 卸载 */ }
  }
}
```

两个函数都必须**同步返回**（或返回一个卸载函数），宿主会在容器卸载时调用它。

插件文件通过 `dola-mod://<id>/<path>` 提供，例如 `dola-mod://library/index.js`。
该协议只映射到插件自己的目录，`../` 越界会被拒绝。

## 宿主桥 `window.__DOLA__`

宿主在渲染前安装一次，插件**不要**打包自己的 React —— 双份 React 会导致 hooks 失效。

```ts
window.__DOLA__ = {
  React,            // 宿主 React 实例
  ReactDOM,         // {...react-dom, ...react-dom/client} 合并，createRoot 在这里
  ReactDOMClient,   // 只含 client 入口（createRoot / hydrateRoot）
  ui: {             // 宿主 ui/controls 的全部导出 + 下面这些
    Button, IconButton, TextInput, TextArea, Select, Slider, Segmented, Tabs,
    Dialog, Menu, Empty, Spinner, Switch, SettingRow,
    Field, Checkbox, Chip, Sheet, Badge, Progress,
    Icon,           // <Icon name="..." size={20} />
    hashHue,        // 由字符串得到稳定色相
    useHotkey       // 快捷键 hook
  },
  toast,            // toast.success / info / warn / error
  useApp,           // zustand store hook（settings、mods、page…）
  version           // 宿主版本号
}
```

渲染进程的 CSP：`script-src` / `style-src` / `img-src` / `font-src` / `connect-src` 都允许
`dola-mod:`，所以插件可以 `fetch('dola-mod://<id>/data.json')` 读取自己目录里的静态文件。
没有 `unsafe-eval`，依赖 `eval` 的库无法使用。

构建时把这些说明符映射到读取 `window.__DOLA__` 的 shim 即可：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`。

## 可调用的宿主能力（`window.api`）

插件运行在宿主渲染进程中，可以直接使用 preload 暴露的接口。常用分组：

| 分组 | 能力 |
| --- | --- |
| `app` | `info()`、窗口控制、`openExternal`、`showItem`、`openLogs`、`capture`、`trayAvailable`、`setTitleBarTheme`、`onCloseAsk`/`resolveClose`；以及整组更新能力：`checkAppUpdate`、`downloadAppUpdate`、`installAppUpdate`、`checkCoreUpdates`、`stageCore`、`stageAllCores`、`stagedCores`、`clearStagedCores`、`applyStagedNow`、`hasStaged`、`takePendingUpdate`、`onUpdateProgress`、`openUpdateLog`、`updateLogPath`、`openReleases` |
| `settings` | `get()` / `patch(patch)` / `reset()` / `onChanged(cb)` |
| `theme` | 取色与主题变更通知 |
| `proxy` | 节点列表、导入订阅、启动/停止、测速 |
| `library` | 书籍导入、书库状态、`onChanged` / `onProgress` |
| `ai` | 对话与分类（需在设置中配置） |
| `sync` | WebDAV 备份与恢复 |
| `fonts` | 字体列表、导入、删除 |
| `mods` | `list()` / `importZip(path)` / `pickAndImport()` / `uninstall(id)` / `setOrder(ids)` / `markIntroduced(id)` / `openFolder()` / `onChanged(cb)` |
| `env` | `platform`、`versions` |
| 顶层 | `onToast(cb)` 订阅主进程推送的提示 |

完整签名见 `src/preload/index.d.ts`（`DolaToolkitApi`）。

### 关于 `settings.patch`

主进程只接受 7 个已知 section（`appearance` / `ai` / `sync` / `proxy` / `library` /
`reader` / `general`）且叶子值必须是原始类型，其它内容会被**静默丢弃**。
插件想保存自己的设置，请用：

- `localStorage`，键名建议加前缀 `dola.<mod-id>.`
- 或写文件并通过清单的 `backupFile` 参与同步

### 运行期报错含义

| 报错 | 原因 |
| --- | --- |
| `插件没有正确注册，可能不是有效的 Dola Toolkit 插件` | 入口脚本执行完但没有注册 `__DOLA_MODS__[id]` |
| `插件文件加载失败` | 入口路径不存在 / 扩展名不在 MIME 白名单 |
| `该插件没有提供界面` / `该插件没有提供设置界面` | 模块没有导出对应的 `mount` / `mountSettings` |
| `无法加载「X」` | 模块加载成功但 mount 抛错 |

## 样式

插件没有独立样式表，直接使用宿主的全局类与 CSS 变量（`--md-primary`、
`--md-surface-container-low`、`--shape-lg`、`--sp-3` 等），因此会自动跟随主题和深浅色。
