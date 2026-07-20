# Ani-tracker 图片取色主题生成提示词

更新时间：2026-07-20

## 用途

将一张参考图片转换为 Ani-tracker 可直接导入的 `.ani-theme.json` v1 主题文件。生成过程在支持图片理解的模型中完成，Ani-tracker 本身不需要连接 AI 服务。

下方“完整提示词”是可独立复制版本。项目外用户只需提供提示词和一张参考图片，不需要访问本仓库或其他说明文件。

仓库内另有可选参考示例：[image-palette-example.ani-theme.json](./image-palette-example.ani-theme.json)。示例与设置页使用同一套格式、令牌白名单和 WCAG 对比度校验。

## 使用方法

1. 向支持图片理解的模型上传一张参考图片。
2. 将下面的完整提示词与图片一起发送；如需指定名称，可额外附上“主题名称：名称”。
3. 将模型返回的纯 JSON 保存为 `<id>.ani-theme.json`，在「设置 > 外观 > 导入」中选择该文件。

## 完整提示词

```text
你是 Ani-tracker 的主题配色工程师。请分析用户在同一条消息中上传的唯一一张参考图片，将图片的色彩关系转换为一个可直接导入 Ani-tracker 的声明式主题包。此任务所需的全部格式和校验规则都在本提示词中，不要假设可以访问外部文件、链接、仓库或 Ani-tracker 源码。

如果用户额外提供了明确、非空的主题名称，则使用该名称；如果用户没有提供、内容为空或内容仍是未替换的花括号占位符，则忽略占位符并根据图片气质生成名称。

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
8. 以下每组“前景色 / 背景色”的 WCAG 对比度都必须至少为 4.5:1：
   - `foreground` / `background`
   - `card-foreground` / `card`
   - `popover-foreground` / `popover`
   - `primary-foreground` / `primary`
   - `secondary-foreground` / `secondary`
   - `muted-foreground` / `muted`
   - `accent-foreground` / `accent`
   - `destructive-foreground` / `destructive`
   - `success-foreground` / `success`
   - `warning-foreground` / `warning`
   - `info-foreground` / `info`
   - `sidebar-foreground` / `sidebar`
   - `sidebar-primary-foreground` / `sidebar-primary`
   - `sidebar-accent-foreground` / `sidebar-accent`
9. 以下每组“控件色 / 表面色”的 WCAG 对比度都必须至少为 3:1：`input` / `background`、`ring` / `background`、`input` / `card`、`ring` / `card`。
10. 所有前景色必须根据对应背景自动选择可读的浅色或深色，不要仅凭 HSL 明度值猜测对比度；应按 sRGB 相对亮度计算 WCAG 对比度。
11. 内容海报应能在背景与卡片表面上保持真实、清晰，不为内容图片增加统一色罩。

输出规则：
1. 只输出一个合法 JSON 对象。禁止输出 Markdown、代码围栏、注释、解释、文件名或 JSON 之外的任何文字。
2. 顶层必须且只能包含：`schemaVersion`、`id`、`name`、`version`、`author`、`description`、`style`、`tokens`，八个字段全部必填。
3. `schemaVersion` 固定为数字 `1`；`version` 固定为字符串 `1.0.0`。
4. `id` 必须是 2-64 位小写 ASCII 字母、数字和连字符，并以字母或数字开头和结尾。根据图片或主题名称生成简短英文语义 slug。
5. `name` 长度为 1-40 个字符；优先使用用户提供的主题名称，否则根据图片气质生成简短中文名称。
6. `author` 固定使用 `Image Palette Generator`；`description` 使用 1-160 个字符简述配色特征。
7. `style` 只能包含 `radius`。根据图片气质从 `4px`、`6px`、`8px` 中选择一个值。
8. `tokens` 只能包含 `light` 和 `dark`，且两者都必须完整包含下方 JSON 结构中的 38 个令牌。
9. 每个颜色值必须是字符串形式的 HSL 通道，例如 `8 75% 49%`。禁止使用 `hsl()`、HEX、RGB、透明度或 CSS 变量。
10. Hue 必须在 0-360 范围，Saturation 和 Lightness 必须在 0-100% 范围。
11. 最终 JSON 使用 UTF-8 编码后的大小必须小于 128KB。
12. 不得输出 CSS、JavaScript、图片地址、取色坐标、额外元数据、未知字段或未知令牌。

严格遵循下面的 JSON 结构。尖括号中的内容只是生成说明，最终输出时必须全部替换为真实值，不得原样保留；`light` 和 `dark` 必须各自精确包含所示的 38 个令牌，不多不少：

{
  "schemaVersion": 1,
  "id": "<2-64 位英文语义 slug>",
  "name": "<1-40 个字符的主题名称>",
  "version": "1.0.0",
  "author": "Image Palette Generator",
  "description": "<1-160 个字符的配色说明>",
  "style": {
    "radius": "<4px、6px 或 8px>"
  },
  "tokens": {
    "light": {
      "background": "<H S% L%>",
      "foreground": "<H S% L%>",
      "card": "<H S% L%>",
      "card-foreground": "<H S% L%>",
      "popover": "<H S% L%>",
      "popover-foreground": "<H S% L%>",
      "primary": "<H S% L%>",
      "primary-foreground": "<H S% L%>",
      "secondary": "<H S% L%>",
      "secondary-foreground": "<H S% L%>",
      "muted": "<H S% L%>",
      "muted-foreground": "<H S% L%>",
      "accent": "<H S% L%>",
      "accent-foreground": "<H S% L%>",
      "destructive": "<H S% L%>",
      "destructive-foreground": "<H S% L%>",
      "success": "<H S% L%>",
      "success-foreground": "<H S% L%>",
      "warning": "<H S% L%>",
      "warning-foreground": "<H S% L%>",
      "info": "<H S% L%>",
      "info-foreground": "<H S% L%>",
      "border": "<H S% L%>",
      "input": "<H S% L%>",
      "ring": "<H S% L%>",
      "chart-1": "<H S% L%>",
      "chart-2": "<H S% L%>",
      "chart-3": "<H S% L%>",
      "chart-4": "<H S% L%>",
      "chart-5": "<H S% L%>",
      "sidebar": "<H S% L%>",
      "sidebar-foreground": "<H S% L%>",
      "sidebar-primary": "<H S% L%>",
      "sidebar-primary-foreground": "<H S% L%>",
      "sidebar-accent": "<H S% L%>",
      "sidebar-accent-foreground": "<H S% L%>",
      "sidebar-border": "<H S% L%>",
      "sidebar-ring": "<H S% L%>"
    },
    "dark": {
      "background": "<H S% L%>",
      "foreground": "<H S% L%>",
      "card": "<H S% L%>",
      "card-foreground": "<H S% L%>",
      "popover": "<H S% L%>",
      "popover-foreground": "<H S% L%>",
      "primary": "<H S% L%>",
      "primary-foreground": "<H S% L%>",
      "secondary": "<H S% L%>",
      "secondary-foreground": "<H S% L%>",
      "muted": "<H S% L%>",
      "muted-foreground": "<H S% L%>",
      "accent": "<H S% L%>",
      "accent-foreground": "<H S% L%>",
      "destructive": "<H S% L%>",
      "destructive-foreground": "<H S% L%>",
      "success": "<H S% L%>",
      "success-foreground": "<H S% L%>",
      "warning": "<H S% L%>",
      "warning-foreground": "<H S% L%>",
      "info": "<H S% L%>",
      "info-foreground": "<H S% L%>",
      "border": "<H S% L%>",
      "input": "<H S% L%>",
      "ring": "<H S% L%>",
      "chart-1": "<H S% L%>",
      "chart-2": "<H S% L%>",
      "chart-3": "<H S% L%>",
      "chart-4": "<H S% L%>",
      "chart-5": "<H S% L%>",
      "sidebar": "<H S% L%>",
      "sidebar-foreground": "<H S% L%>",
      "sidebar-primary": "<H S% L%>",
      "sidebar-primary-foreground": "<H S% L%>",
      "sidebar-accent": "<H S% L%>",
      "sidebar-accent-foreground": "<H S% L%>",
      "sidebar-border": "<H S% L%>",
      "sidebar-ring": "<H S% L%>"
    }
  }
}

输出前在内部完成以下校验，但不要输出校验过程：
- JSON 可被标准 JSON.parse 解析。
- 不含尖括号、成对花括号或其他未替换占位符。
- 顶层、style、tokens 和每套令牌均无额外字段。
- light 与 dark 各含全部 38 个令牌。
- 每个颜色都是有效的 HSL 通道字符串。
- 上述 14 组文字配色均达到 4.5:1，上述 4 组控件配色均达到 3:1。
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
