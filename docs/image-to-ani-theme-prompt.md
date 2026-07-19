# Ani-tracker 图片取色主题生成提示词

更新时间：2026-07-19

## 用途

将一张参考图片转换为 Ani-tracker 可直接导入的 `.ani-theme.json` v1 主题文件。生成过程在支持图片理解的模型中完成，Ani-tracker 本身不需要连接 AI 服务。

## 使用方法

1. 向支持图片理解的模型上传一张参考图片。
2. 将下面的完整提示词与图片一起发送；可填写可选主题名称。
3. 将模型返回的纯 JSON 保存为 `<id>.ani-theme.json`，在「设置 > 外观 > 导入」中选择该文件。

## 完整提示词

```text
你是 Ani-tracker 的主题配色工程师。请分析用户上传的唯一一张参考图片，将图片的色彩关系转换为一个可直接导入 Ani-tracker 的声明式主题包。

可选主题名称：{{theme_name}}

目标：
- 保留参考图片的主要色相、冷暖关系、明度层级和视觉气质。
- 生成适合高信息密度桌面工具的浅色与深色主题，而不是制作图片滤镜。
- 输出结果必须能通过 Ani-tracker 现有 `.ani-theme.json` v1 校验器。

分析规则：
1. 在内部识别图片的主强调色、次强调色、浅中性色、深中性色和可用前景色，但不要输出分析过程。
2. `primary` 选择最能代表图片且适合主要操作的颜色；不得与 `destructive` 混淆。
3. `secondary` 和 `accent` 使用图片中的辅助色或主色低饱和变体，用于次级表面和选中背景。
4. `background`、`card`、`popover`、`sidebar` 必须低干扰并有可辨识层级，不得直接使用高饱和主色铺满页面。
5. 图片缺少状态色时，生成与整体色调协调但语义清晰的绿色 `success`、琥珀色 `warning`、蓝色 `info` 和红色 `destructive`。
6. `chart-1` 至 `chart-5` 应可相互区分，并保持与图片色板协调。
7. 深色主题必须独立调整明度和饱和度，保持相同色相性格；禁止简单反相浅色主题。
8. 正文与背景对比度至少为 4.5:1；大文字、焦点环和关键边界至少为 3:1。
9. `primary-foreground`、各状态前景色和侧栏前景色必须根据对应背景自动选择可读的浅色或深色。
10. 内容海报应能在背景与卡片表面上保持真实、清晰，不为内容图片增加统一色罩。

输出规则：
1. 只输出一个合法 JSON 对象。禁止输出 Markdown、代码围栏、注释、解释、文件名或 JSON 之外的任何文字。
2. 顶层只能包含：`schemaVersion`、`id`、`name`、`version`、`author`、`description`、`style`、`tokens`。
3. `schemaVersion` 固定为数字 `1`；`version` 固定为字符串 `1.0.0`。
4. `id` 必须是 2-64 位小写 ASCII 字母、数字和连字符，并以字母或数字开头。根据图片或主题名称生成简短英文语义 slug。
5. `name` 长度为 1-40 个字符；优先使用用户提供的主题名称，否则根据图片气质生成简短中文名称。
6. `author` 使用 `Image Palette Generator`；`description` 不超过 160 个字符。
7. `style` 只能包含 `radius`。根据图片气质从 `4px`、`6px`、`8px` 中选择一个值。
8. `tokens` 只能包含 `light` 和 `dark`，且两者都必须完整包含下方列出的 38 个令牌。
9. 每个颜色值必须是字符串形式的 HSL 通道，例如 `8 75% 49%`。禁止使用 `hsl()`、HEX、RGB、透明度或 CSS 变量。
10. Hue 必须在 0-360 范围，Saturation 和 Lightness 必须在 0-100% 范围。
11. 不得输出 CSS、JavaScript、图片地址、取色坐标、额外元数据、未知字段或未知令牌。

`light` 和 `dark` 必须各自精确包含以下 38 个键，不多不少：

background
foreground
card
card-foreground
popover
popover-foreground
primary
primary-foreground
secondary
secondary-foreground
muted
muted-foreground
accent
accent-foreground
destructive
destructive-foreground
success
success-foreground
warning
warning-foreground
info
info-foreground
border
input
ring
chart-1
chart-2
chart-3
chart-4
chart-5
sidebar
sidebar-foreground
sidebar-primary
sidebar-primary-foreground
sidebar-accent
sidebar-accent-foreground
sidebar-border
sidebar-ring

输出前在内部完成以下校验，但不要输出校验过程：
- JSON 可被标准 JSON.parse 解析。
- 顶层、style、tokens 和每套令牌均无额外字段。
- light 与 dark 各含全部 38 个令牌。
- 每个颜色都是有效的 HSL 通道字符串。
- 所有主要文字、按钮文字和状态文字满足对比度要求。
- 深色主题不是浅色主题的机械反相。

现在根据用户上传的图片生成最终主题 JSON。
```

## 输出文件约束

| 项目 | 要求 |
| --- | --- |
| 文件名 | `<id>.ani-theme.json` |
| 编码 | UTF-8 |
| 最大文件大小 | 128KB |
| Schema | Ani-tracker Theme Pack v1 |
| 明暗模式 | `tokens.light` 与 `tokens.dark` 均必填 |
| 颜色格式 | `H S% L%`，不包含 `hsl()` |
| 圆角范围 | 0-12px；提示词默认限定为 4px、6px、8px |
| 安全边界 | 不允许 CSS、JavaScript、外链或未知字段 |

## 导入失败排查

- 确认模型只返回 JSON，没有代码围栏或说明文字。
- 确认文件扩展名为 `.ani-theme.json` 或 `.json`。
- 确认 `light` 和 `dark` 都包含全部 38 个令牌。
- 确认颜色值类似 `8 75% 49%`，没有 `#`、逗号或 `hsl()`。
- 确认 `id` 只包含小写字母、数字和连字符。
