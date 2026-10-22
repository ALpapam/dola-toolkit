# 多拉工具箱 · Dola Toolkit

> **beta 0.0.2** — 一个 **Material You（MD3 / Material Design 3）** 风格的 Windows 桌面工具箱。
> 纯本地运行，**完全开源（MIT）**，不上传任何用户数据。

[![version](https://img.shields.io/badge/version-beta%200.0.2-9A6BD8)](https://github.com/ALpapam/dola-toolkit/releases)
[![license](https://img.shields.io/badge/license-MIT-2E9E5B)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-4A90D9)](https://github.com/ALpapam/dola-toolkit/releases)
[![electron](https://img.shields.io/badge/Electron-44-47848F)](https://www.electronjs.org/)

---

## 这是什么

多拉工具箱把几个常用的桌面小工具放进同一个窗口，用 Material You 的取色系统统一外观。
左侧图标栏收起时只显示图标，展开显示名称，工具顺序可以拖动调整。

当前包含两个工具：

| 工具 | 说明 |
| --- | --- |
| **代理** | v2rayN 风格的节点管理，支持分享链接导入、分流模式、延迟测试、系统代理与托盘常驻 |
| **书库** | 本地电子书管理 + 内置阅读器，支持多格式、双页排版、AI 自动归类与 WebDAV 同步 |

---

## 下载与安装

到 [Releases](https://github.com/ALpapam/dola-toolkit/releases) 下载：

| 文件 | 说明 |
| --- | --- |
| `DolaToolkit-0.0.2-setup.exe` | **安装版**（推荐）。可选择安装目录，创建快捷方式 |
| `DolaToolkit-0.0.2-portable.exe` | **便携版**。免安装，适合放在固定目录使用 |

**安装版说明**

- 安装向导支持**自选安装文件夹**
- 在**桌面**与**开始菜单**创建快捷方式
- 快捷方式名跟随系统语言：中文系统为「**多拉工具箱**」，其它语言为「**Dola Toolkit**」
- 安装过程会展示[用户协议](EULA.md)，同意后才会继续
- 卸载**不会**删除你的配置与书库数据（见「数据存放位置」）

**系统要求**：Windows 10 / 11 x64。

### 代理内核

代理功能依赖三个内核。它们**不在**安装包内（体积大，且会让每次启动多一次解压），
需要放在程序目录下的 `cores` 文件夹里：

```
Dola Toolkit/
├─ Dola Toolkit.exe
├─ cores/
│  ├─ xray/xray.exe
│  ├─ singbox/sing-box.exe
│  ├─ mihomo/mihomo.exe
│  └─ geofiles/{geoip.dat, geosite.dat}
└─ resources/geo/{geosite-cn.srs, geoip-cn.srs}
```

内核均来自各自的开源项目，地址见[第三方组件声明](THIRD-PARTY-NOTICES.md)。
**书库功能不需要内核**，开箱可用。

---

## 功能

### 代理

| 特性 | 说明 |
| --- | --- |
| 协议 | VMess / VLESS / Trojan / Shadowsocks / SOCKS5 / HTTP / Hysteria2 / TUIC / AnyTLS |
| 内核 | Xray、sing-box、Mihomo 三选一，按协议自动匹配 |
| 导入 | 分享链接批量导入、手动添加、随时编辑已有节点 |
| **分流模式** | **绕过大陆**（默认，国内直连）／ **全局代理**，一键切换 |
| DNS | 国内域名走本地 DNS、境外走隧道内 DoH 防污染；域名在客户端解析，避免服务器侧解析失败断流 |
| Hysteria2 | 支持自签证书的 `pinSHA256` 公钥固定；pin 过期时可对该节点单独关闭证书校验 |
| 诊断 | 延迟 + 出口 IP/国家；失败时给出可操作原因（证书不匹配、超时、端口不通…） |
| 系统代理 | 一键接管 Windows 系统代理，退出时还原原有设置 |
| 托盘 | 关闭可最小化到托盘；托盘菜单查看状态、启停代理、退出 |

### 书库

| 特性 | 说明 |
| --- | --- |
| 格式 | EPUB / PDF / MOBI / FB2 / TXT / RTF |
| 阅读器 | 自定义字体（默认 JetBrains Maple Mono NF）、字号、行距、单页/双页跨页 |
| 翻页 | Canvas 纸张卷曲动画；**点按右侧 1/3 下一页、左侧 1/3 上一页**，中间区域不翻页 |
| 管理 | 网格/列表视图、书架文件夹、搜索排序、阅读进度 |
| 归类 | 可选 AI 自动分类（填你自己的接口地址与密钥） |
| 同步 | 可选 WebDAV 同步书库索引与阅读进度 |

### 界面

- Material You 取色：跟随壁纸或系统强调色，也可手动选预设配色
- 纯色填充 + 描边风格，不使用渐变
- 自绘下拉框、对话框、开关、滑块，带动画并支持键盘操作
- 右键菜单：剪切 / 复制 / 粘贴 / 全选
- 点击左上角图标随时返回主页

---

## 数据存放位置

所有数据都在本机，**不会上传**。只有你主动开启 WebDAV 同步或 AI 归类时，
才会把书库数据/书名作者发往**你自己填写**的地址。

```
%APPDATA%\dola-toolkit\
├─ settings.json     设置、AI 接口地址与密钥
├─ proxy.json        节点列表（含凭据）
├─ library\          书库索引
├─ covers\           封面缓存
└─ logs\             运行日志
```

> ⚠️ `proxy.json` 保存着节点的 UUID / 密码，`settings.json` 可能含 AI 密钥。
> 分享配置或反馈问题前请注意打码。

彻底清除：退出程序后删除整个 `%APPDATA%\dola-toolkit` 目录。

---

## 从源码构建

```bash
npm install           # 或 pnpm install
npm run dev           # 开发模式
npm run build         # 编译
npm run typecheck     # 类型检查

# 打包（安装版 + 便携版）
npx electron-builder --win nsis portable --x64
```

产物在 `dist/`：`DolaToolkit-<version>-setup.exe` 与 `DolaToolkit-<version>-portable.exe`。

技术栈：Electron 44 · electron-vite · React 19 · TypeScript 5.9（strict）· Zustand。
界面未使用任何 UI 框架，全部手写 CSS 变量与组件。

---

## 开源协议

| 内容 | 协议 |
| --- | --- |
| 本程序源码 | [MIT](LICENSE) — 可自由使用、修改、再发布 |
| 用户使用条款 | [用户协议](EULA.md) |
| 第三方组件 | [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md) |

> 分发修改版时请更换名称与图标，避免与原版混淆。

---

## 已知限制

- 仅支持 Windows x64
- 代理内核需单独放置，安装包不含内核（见上文）
- 便携版每次启动会把自身解压到临时目录，**首次启动较慢**
- 未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」即可

---

## 反馈

- 问题与建议：<https://github.com/ALpapam/dola-toolkit/issues>
- 版本历史：<https://github.com/ALpapam/dola-toolkit/releases>
