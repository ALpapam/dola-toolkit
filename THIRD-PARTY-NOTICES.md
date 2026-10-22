# 第三方组件声明 / Third-Party Notices

Dola Toolkit 以 MIT 许可证开源（见 [LICENSE](LICENSE)）。它同时使用了下列第三方组件。
每个组件遵循其自身的许可证，本文件仅作汇总说明。

Dola Toolkit itself is MIT-licensed (see [LICENSE](LICENSE)). It bundles and uses the
components below, each under its own license.

---

## 运行时依赖 / Runtime libraries

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 桌面运行时 |
| [React](https://github.com/facebook/react) | MIT | 界面 |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | 状态管理 |
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF 渲染 |
| [epub.js](https://github.com/futurepress/epub.js) | BSD-3-Clause | EPUB 渲染 |
| [jszip](https://github.com/Stuk/jszip) | MIT OR GPL-3.0 | EPUB 解包（按 MIT 使用） |
| [@iconify-json/material-symbols](https://github.com/iconify/icon-sets) | Apache-2.0 | Material Symbols 图标 |

## 代理内核 / Proxy cores

这些程序作为**独立可执行文件**随软件分发，通过命令行启动并以本地端口通信，
不属于本软件的派生作品。它们的源代码可从各自的仓库获取。

These are shipped as **separate executables** and are started as child processes
communicating over a local port; they are not derived works of Dola Toolkit.

| 内核 | 许可证 | 源码 |
| --- | --- | --- |
| [Xray-core](https://github.com/XTLS/Xray-core) | MPL-2.0 | <https://github.com/XTLS/Xray-core> |
| [sing-box](https://github.com/SagerNet/sing-box) | GPL-3.0-or-later | <https://github.com/SagerNet/sing-box> |
| [Mihomo](https://github.com/MetaCubeX/mihomo) | GPL-3.0 | <https://github.com/MetaCubeX/mihomo> |

## 规则数据 / Rule data

| 数据 | 许可证 | 来源 |
| --- | --- | --- |
| geoip.dat / geosite.dat | 见上游 | [Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat) |
| geosite-cn.srs / geoip-cn.srs | 见上游 | [SagerNet/sing-geosite](https://github.com/SagerNet/sing-geosite)、[SagerNet/sing-geoip](https://github.com/SagerNet/sing-geoip) |

## 字体 / Fonts

| 字体 | 许可证 |
| --- | --- |
| JetBrains Maple Mono NF（阅读与界面等宽字体，若随包分发） | SIL Open Font License 1.1 |

---

## 关于 GPL 组件的说明 / Note on GPL components

sing-box 与 Mihomo 采用 GPL-3.0。本软件通过**独立进程**调用它们（启动可执行文件并
以标准输入输出/本地端口交互），不将它们的代码链接进本程序，因此本程序的 MIT 许可不受
影响。如果你再分发本软件的二进制版本，请一并保留这些内核的原始文件与其许可证信息。

sing-box and Mihomo are GPL-3.0. This app invokes them as **separate processes**
(spawning the executable and talking to a local port), and does not link their code
into the application, so the MIT license of this project is unaffected. If you
redistribute the binaries, keep those cores intact together with their license files.

---

如果你认为某个组件的署名或授权有遗漏，请到
<https://github.com/ALpapam/dola-toolkit/issues> 提出，我们会尽快修正。
