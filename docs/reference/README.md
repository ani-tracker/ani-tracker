# 参考资料

本目录保存仍可复用、但不直接描述项目完成度的资料。

## 主题生成

- [图片取色主题生成提示词](theme-generation/image-to-ani-theme-prompt.md)
- [Theme Pack v2 示例](theme-generation/image-palette-example.ani-theme.json)

主题格式的代码事实位于 `src/shared/theme.ts`。提示词或示例与校验器冲突时，应更新本目录资料，而不是放宽运行时安全校验。

`docs/自定义主题提示词/` 暂时保留同内容的兼容副本，因为现有跨平台测试仍按旧路径读取主题示例。修改本目录主题资料时应同步兼容副本；待测试切换路径后再删除旧目录。
