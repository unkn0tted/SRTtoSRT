# Subtitle Duet

本地跨平台字幕翻译器，基于 `Tauri v2 + TypeScript + Vite`。

当前范围：

- 仅支持导入 `SRT`
- 批量调用兼容 OpenAI `chat/completions` 接口
- 导出 `上中文 / 下英文` 的双语 `SRT`
- 支持用户自定义 `API Base URL / API Key / Model / 请求头 / Prompt`

## 当前实现

- 前端负责：
  - 读取本地 SRT
  - 解析与导出双语 SRT
  - 批量队列、进度、日志、配置持久化
- Tauri 原生层负责：
  - 通过 Rust 发起 HTTP 请求，避开浏览器 CORS

## 运行前提

你本机需要先安装：

- `Node.js`
- `Rust / Cargo`
- Tauri 官方依赖

参考官方文档：

- https://v2.tauri.app/start/prerequisites/

## 安装依赖

```bash
npm install
```

## 开发模式

```bash
npm run tauri:dev
```

## 打包

```bash
npm run tauri:build
```

## 推荐发布方式

如果你不想把开发机和高性能 Windows 机器都装得很脏，推荐直接使用项目里的 GitHub Actions 矩阵构建：

- 工作流文件：`.github/workflows/tauri-build.yml`
- 触发方式：
  - 手动触发 `workflow_dispatch`
  - 推送 `v*` 标签时自动触发
- 产物：
  - Linux：`bundle` 目录下的 Linux 安装包 / AppImage
  - Windows：`bundle` 目录下的安装包，额外附带 `portable/subtitle-duet-windows-portable.zip`
  - macOS：`bundle` 目录下的 macOS 安装产物

这样本地机器只负责开发和单端调试，三平台正式包交给各自 runner 产出。

## 使用说明

1. 填写 `API Base URL / API Key / Model`
2. 选择英文行模式：
   - `保留原文`：下行直接复用源字幕
   - `强制输出英文`：模型返回中文和英文
3. 选择多个 `SRT` 文件
4. 选择输出目录
5. 点击“开始翻译”

输出文件会命名为：

```text
原文件名.bilingual.srt
```

## 兼容性说明

- 默认请求到 `${API Base URL}/chat/completions`
- 如果你填写的 URL 本身已经以 `/chat/completions` 结尾，则会直接使用
- 附加请求头需要是 JSON 对象，例如：

```json
{
  "x-api-key": "demo"
}
```

## 当前已知限制

- 还没有做任务取消和断点续跑
- 对非常复杂的字幕格式标签没有专门保护逻辑
- 没有内置术语表和上下文记忆
- 当前这台 Linux 机器已经装好 Node / Rust 和 Tauri 依赖，但 `release/debug` 的 GTK 编译都被内存上限杀掉了，不适合继续作为正式打包机
- macOS 对外分发若要减少系统安全警告，后续通常还要补签名 / 公证流程
