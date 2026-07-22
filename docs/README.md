# Ani Tracker 文档索引

最近核对：2026-07-21

本目录按“现行文档、参考资料、历史归档”分层。现行文档描述当前代码；历史归档只保存决策过程，不作为实现依据。

## 现行文档

| 文档 | 用途 |
| --- | --- |
| [架构与设计](design-plan.md) | 当前进程边界、服务职责、数据流和扩展边界 |
| [实现状态](progress.md) | 已实现能力、明确限制和后续工作 |
| [内置 libtorrent 下载引擎计划](embedded-libtorrent-engine-plan.md) | 跨平台内置 BT 内核的目标、阶段和验收标准 |
| [启动说明](startup.md) | 安装、开发、测试、构建和排障 |
| [界面设计规范](DESIGN.md) | 当前应用壳、设计令牌、组件和响应式约束 |

## 参考资料

- [参考资料索引](reference/README.md)
- [图片取色主题生成提示词](reference/theme-generation/image-to-ani-theme-prompt.md)
- [可导入主题示例](reference/theme-generation/image-palette-example.ani-theme.json)

## 历史归档

- [归档说明](archive/README.md)
- [2026-07 UI 改造归档](archive/2026-07-ui-redesign/README.md)

## 事实优先级

文档与实现冲突时，按以下顺序核对并修正文档：

1. `src/shared` 中的领域模型、持久化版本和 IPC 契约。
2. `src/main`、`src/preload`、`src/renderer/src` 的当前实现。
3. `package.json`、`pnpm-workspace.yaml` 和资源准备脚本。
4. 本目录的现行文档。
5. `docs/archive` 中的历史记录。

## 维护规则

- 功能完成、取消或改变边界时同步更新 `progress.md` 和相关现行文档。
- 阶段性计划结束后移入带日期的 `archive` 子目录，并在归档索引注明时间和范围。
- 历史文档只修复归档标识和链接，不改写当时结论。
- 文档不得把占位实现、待真机验收或平台缺失资源描述为已完成。
- 不在 `docs` 保存临时截图、构建产物或无法追溯用途的附件。
