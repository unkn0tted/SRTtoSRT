<div align="center">
  <h1>Subtitle Duet</h1>
  <p><strong>把单语 SRT，整理成可交付的双语字幕。</strong></p>
  <p>基于 <code>Tauri v2 + TypeScript + Rust</code> 的本地桌面工具，批量读取字幕文件，调用 OpenAI 兼容接口，导出上中文 / 下英文的双语 <code>.srt</code>。</p>

  <p>
    <img alt="Tauri v2" src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
    <img alt="Rust" src="https://img.shields.io/badge/Rust-Native-000000?style=for-the-badge&logo=rust&logoColor=white">
    <img alt="OpenAI Compatible" src="https://img.shields.io/badge/OpenAI-Compatible-0F172A?style=for-the-badge">
  </p>
</div>

---

## 为什么是它

`Subtitle Duet` 不是在线网页小工具，而是一个偏交付型的本地桌面应用：

- 只做一件事：把 `SRT` 批量翻译成双语字幕
- 所有文件读写都在本地完成
- 通过 Tauri 原生层发起 HTTP 请求，避开浏览器 `CORS`
- 支持断点续跑、进度日志、本地设置持久化
- 支持无边框窗口和自定义标题栏，桌面体验更完整

> 适合需要反复处理一批字幕、又不想把 API Key 和文件流程塞进浏览器的人。

## 功能亮点

| 模块 | 能力 |
| --- | --- |
| 输入 | 仅支持导入 `SRT`，避免格式分支过多导致流程变复杂 |
| 翻译 | 批量调用兼容 OpenAI `chat/completions` 的接口 |
| 输出 | 导出 `上中文 / 下英文` 的双语 `SRT` |
| 英文模式 | 可保留原文，或要求模型补全英文行 |
| 参数控制 | 支持自定义 `API Base URL / API Key / Model / 请求头 / Prompt` |
| 任务管理 | 支持多文件队列、并发、进度显示和日志记录 |
| 容错 | 输出目录旁生成 checkpoint，异常后可继续跑 |
| 本地数据 | 设置保存到应用数据目录，可打开、重置、清理 |

## 工作方式

### 前端负责

- 读取本地 `SRT`
- 解析字幕时间轴与文本
- 组织批处理任务
- 展示日志、状态和进度
- 导出双语字幕文件

### Tauri 原生层负责

- 用 Rust 发起 HTTP 请求
- 规避浏览器环境的跨域限制
- 提供本地目录打开等桌面能力
- 接管无边框窗口的标题栏交互

## 典型流程

```text
选择 SRT 文件
  -> 配置 API / Model / Prompt
  -> 选择英文行模式
  -> 选择输出目录
  -> 批量翻译
  -> 导出 *.bilingual.srt
```

输出文件命名规则：

```text
原文件名.bilingual.srt
```

## 快速开始

### 1. 环境准备

你需要先安装：

- `Node.js`
- `Rust / Cargo`
- Tauri 官方依赖

官方前置说明：

- https://v2.tauri.app/start/prerequisites/

### 2. 安装依赖

```bash
npm install
```

### 3. 启动开发模式

```bash
npm run tauri:dev
```

### 4. 构建桌面应用

```bash
npm run tauri:build
```

`npm run tauri:dev` 和 `npm run tauri:build` 都会先根据 [src-tauri/icons/icon.png](src-tauri/icons/icon.png) 自动生成平台图标，避免 Windows 或 macOS 因缺少 `icon.ico` / `icon.icns` 导致打包失败。

## 使用说明

1. 填写 `API Base URL / API Key / Model`
2. 选择英文行模式
3. 选择多个 `SRT` 文件
4. 选择输出目录
5. 点击“开始翻译”

英文行模式说明：

- `保留原文`：下行直接复用源字幕
- `强制输出英文`：模型返回中文和英文

附加请求头必须是 JSON 对象，例如：

```json
{
  "x-api-key": "demo"
}
```

接口拼接规则：

- 默认请求 `${API Base URL}/chat/completions`
- 如果你填写的 URL 已经以 `/chat/completions` 结尾，则直接使用

## 本地数据

应用会把设置保存到应用数据目录中的 `settings.json`，界面中会显示实际路径，并提供这些操作：

- 打开数据目录
- 重置所有本地设置
- 一键清理本地数据

除此之外：

- 翻译过程中会在输出目录旁边临时生成 `*.bilingual.checkpoint.json`
- 成功导出后，checkpoint 文件会自动删除
- 旧版 `localStorage` 设置会自动迁移到文件存储

## 发布流程

项目已经带好 GitHub Actions 矩阵构建和自动 Release 工作流：

- 工作流文件：[.github/workflows/tauri-build.yml](.github/workflows/tauri-build.yml)
- `workflow_dispatch`：
  - 构建 Linux / Windows / macOS
  - 上传各平台 bundle 到 Actions artifacts
- 推送 `v*` 标签：
  - 校验 Git tag 与项目版本号一致
  - 构建 Windows / macOS
  - 自动创建 GitHub Release
  - 自动生成 Release Notes
  - 自动上传安装包和便携包

版本发布前，下面三个文件里的版本号必须完全一致：

- [package.json](package.json)
- [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)
- [src-tauri/Cargo.toml](src-tauri/Cargo.toml)

示例：

```bash
git tag v0.1.3
git push origin v0.1.3
```

## 当前限制

- 还没有做任务取消
- 断点续跑目前只适用于同一输入文件、同一输出目录、同一套翻译参数
- 对复杂字幕标签暂时没有专门保护逻辑
- 没有内置术语表和上下文记忆
- 自定义标题栏在 Windows / Linux 更直接，macOS 仍建议真机验证交互手感
- 当前 Linux 机器不适合作为正式 GTK 打包机
- Windows 签名与 macOS 签名 / 公证流程暂未接入

## 项目定位

这个项目更像一把锋利的小工具，而不是一个“大而全”的字幕平台。

它优先解决的是：

- 本地文件安全感
- OpenAI 兼容接口的灵活接入
- 批量任务的稳定执行
- 尽量少折腾的桌面交互体验

如果你想把它继续往下做，下一步最值得加的通常是：

- 任务取消
- 术语表
- 标签保护
- 更完整的 macOS 原生体验校验
