# BOBOCLOUD AI Agent

Official local AI Agent plugin for BOBOCLOUD. It adds an Agent workbench as a peer of code editor tabs while leaving the built-in Chat and inline completion features independent.

The plugin is written in plain JavaScript and has no runtime dependencies or native modules. Privileged work remains in BOBOCLOUD's cross-platform host brokers, so one package can run on Windows, macOS, and Linux.

Version `1.1.0` requires BOBOCLOUD `>=2.8.0 <3.0.0` and Plugin API `^1.5.0`.

## Capabilities

- Persistent, searchable Agent sessions rendered by the host workbench.
- `chat` and multi-step `goal` modes.
- `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort selection.
- Session-scoped `ask`, `auto`, and `full` access-mode display state without moving authority into the plugin.
- Discovery and explicit selection of workspace or user `SKILL.md` files.
- Automatic threshold-based context compaction with durable recovery summaries, recent-turn retention, and visible progress.
- Structured workspace list, read, and search tools.
- Approval-gated workspace writes with optimistic SHA-256 concurrency checks.
- Approval-gated allowlisted process execution with structured arguments and no shell.
- Real model cancellation, with approval execution and process cancellation owned entirely by the trusted host.
- English, Simplified Chinese, and Japanese UI strings.

## Trust Boundary

This package runs in BOBOCLOUD's isolated extension Worker. It has no Node.js, Electron, DOM, raw filesystem, shell, environment, network, credential, or IPC access. It receives model profiles only as opaque references and invokes local tools only through named host operations. `context.tools` exposes only `invoke`; approval execution, rejection, cancellation, and canonical approval details never enter the Worker. The host returns a bounded trusted `approvalResult` with the approve or reject command so orchestration can continue. `accessMode` in plugin preferences and state is only a mirror for orchestration guidance; the trusted host separately owns the effective access policy and the plugin never self-approves.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the ownership model, state machine, data contracts, and lifecycle rules.

## Build and Test

Node.js 20 or newer is sufficient; there are no dependencies to install.

Run the focused orchestration suite without regenerating release artifacts:

```sh
node --test tests/extension.test.mjs
```

The full release checks are:

```sh
npm test
npm run package
npm run verify
```

`npm run package` copies the self-contained source to `dist/extension.js`, regenerates every manifest integrity hash, and writes a deterministic artifact:

```text
artifacts/bobocloud.ai-agent-1.1.0.boboplugin
artifacts/bobocloud.ai-agent-1.1.0.boboplugin.sha256
```

The archive contains only `manifest.json`, `dist/extension.js`, and the three locale catalogs. Source, tests, scripts, and repository metadata are intentionally excluded.

## Install

Use BOBOCLOUD's Extensions view to install the `.boboplugin` archive, then enable the plugin. Version `1.1.0` requires BOBOCLOUD `2.8.0` or newer. Configure at least one Chat model in BOBOCLOUD's AI settings. The Agent activity item appears only while the plugin is enabled.

The Agent does not share conversations with Chat and does not replace inline completion. It only reuses host-owned model connection profiles through opaque model references.

## Release and Marketplace Registration

1. Update the version in `package.json` and `manifest.json` together.
2. Run `npm test` and `npm run package`.
3. Commit the generated `dist/extension.js`, `manifest.json`, archive, and checksum. The registry's approved raw GitHub URL must resolve from the immutable tag.
4. Tag the commit as `v<version>` and push the tag. The release workflow verifies the tag, rebuilds the deterministic package, and uploads the archive plus checksum.
5. Register the immutable raw-tag artifact in `BOBOCloud-Marketplace-Registry` with the exact archive byte size and SHA-256.
6. Propagate hashes from the version descriptor to the package index, official shard, and root registry, then run the registry validator.
7. Download the published asset again and compare its bytes, size, and SHA-256 with the registry descriptor before announcing the release.

Marketplace artifact URL pattern:

```text
https://raw.githubusercontent.com/NemophilistJohn/BOBOCloud-AI-Agent-plugin-offical/v1.1.0/artifacts/bobocloud.ai-agent-1.1.0.boboplugin
```

The release workflow also publishes the same bytes as a GitHub Release asset:

```text
https://github.com/NemophilistJohn/BOBOCloud-AI-Agent-plugin-offical/releases/download/v1.1.0/bobocloud.ai-agent-1.1.0.boboplugin
```

## 中文说明

这是 BOBOCLOUD 官方本地 AI Agent 插件。Agent 以与代码文件同级的工作台选项卡出现，左侧提供会话列表；它与内置 Chat、行内补全相互独立，只通过宿主提供的不透明模型引用复用已有 AI 连接配置。

插件本身不接触 Node.js、Electron、绝对路径、Shell、网络、密钥或原始 IPC。文件写入和进程执行都必须经过 BOBOCLOUD 的显式审批，并由宿主在当前工作区边界内完成。

`1.1.0` 面向 BOBOCLOUD 2.8 / Plugin API 1.5：增加 `xhigh` 思考强度、会话级访问模式镜像和自动上下文压缩。访问模式不授予权限，真正的自动批准规则始终由可信宿主掌握。
