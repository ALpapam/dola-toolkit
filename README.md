# 多拉工具箱 · Dola Toolkit

> **beta 0.4.4** — 一个 **Material You（MD3）** 风格的 Windows 桌面工具箱，内置工具全部以**可安装插件**的形式存在。

[![version](https://img.shields.io/badge/version-beta%200.4.4-C77DFF)](https://github.com/ALpapam/dola-toolkit/releases)
[![license](https://img.shields.io/badge/license-MIT-2E9E96)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-2F6FB5)](#)

纯本地运行，不上传任何用户数据。

> 主程序本身**不包含任何工具**。首次安装后从 [Dola-Toolkit-mod](https://github.com/ALpapam/Dola-Toolkit-mod/releases)
> 下载插件包，拖进「添加工具」页面即可使用。

---

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 插件化工具 | `.zip` 插件包，导入即用，可卸载、可拖动排序、按版本号升级 |
| Material You 主题 | 11 套配色，跟随系统深浅色 |
| 三页式主菜单 | 欢迎页 / 工具快捷方式 / 运行状态，滚轮或鼠标拖动翻页 |
| WebDAV 同步 | 弹窗勾选要备份的内容：设置、书库元数据、各插件自己的数据 |
| 内核更新 | 校验 SHA-256 后暂存，重启时替换，下载期间不中断代理 |
| 内置更新器 | 自更新走代理，带完整性校验与完整日志 |

---

## 插件

工具不再是写死在程序里的页面，而是独立的 `.zip` 包：

| 插件 | 说明 |
| --- | --- |
| **代理** | Xray / sing-box / Mihomo 多内核代理，订阅导入、节点测速、分流规则、系统代理 |
| **书库** | EPUB / PDF / FB2 / MOBI / TXT / RTF 阅读器，AI 自动归类与 WebDAV 同步 |

下载：[Dola-Toolkit-mod Releases](https://github.com/ALpapam/Dola-Toolkit-mod/releases)

**插件开发**

清单格式、宿主桥 `window.__DOLA__`、`window.api` 全部接口、构建与打包方式，以及一个
可运行的最小示例，都在 [Dola-Toolkit-mod](https://github.com/ALpapam/Dola-Toolkit-mod)。

---

## 安装

下载 `DolaToolkit-0.4.4-setup.exe`（安装版）或 `DolaToolkit-0.4.4-portable.exe`（便携版）。

安装版可选目录、按机器安装（需要管理员权限）；便携版解压即用。

装好之后：

1. 打开侧边栏底部的「添加工具」
2. 把 `proxy-x.x.x.zip`、`library-x.x.x.zip` 拖进页面（或点按钮选择）
3. 工具会出现在侧边栏，首次打开会显示使用说明

---

## 开发

```bash
npm install
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm run build      # 构建
npm run dist:win   # 打包安装版与便携版
```

**环境要求**：Node.js 20+、Windows 10/11 x64。

### 代理内核

内核二进制约 180 MB，且各自许可不同，**不随仓库分发**。自行放入：

```
cores/xray/xray.exe
cores/singbox/sing-box.exe
cores/mihomo/mihomo.exe
cores/geofiles/geoip.dat
cores/geofiles/geosite.dat
```

程序按以下顺序查找 `cores` 目录：安装目录旁的 `cores`、上一级的 `cores`、
`resources/cores`，最后是 `Dola Toolkit` 数据目录。

### 目录结构

```
src/
  main/          主进程：窗口、托盘、代理内核、更新器、插件安装
    mods/        插件安装 / 卸载 / 版本比较 / dola-mod:// 协议
  preload/       contextBridge 接口
  renderer/      渲染层：外壳、首页、设置、插件宿主
  shared/        主进程与渲染层共享的类型与常量
```

> 插件源码不在本仓库，见 [Dola-Toolkit-mod](https://github.com/ALpapam/Dola-Toolkit-mod)。

### 技术栈

Electron 44 · TypeScript 5.9（strict）· React 19 · Vite 8 / electron-vite 6 · Zustand · electron-builder 26

---

## 许可

MIT，见 [LICENSE](LICENSE)。随包附带的第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。