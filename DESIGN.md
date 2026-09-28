# AI Gateway Design System

> 科技风格（电光蓝青 · 终端质感）设计契约。本文件是所有前端视觉决策的唯一事实源：
> 任何颜色、字号、间距、阴影值必须先在此登记，代码中禁止出现绕过令牌的裸 hex。
>
> **参考选型**（redesign 路由：redesign-skill + layout-skill + Layer B）：
> - Layer B 令牌源：`references/design/raycast.md` —— 蓝调近黑底（非纯黑）、
>   多层 inset 阴影的 macOS 质感、正向字距、终端/精密仪器氛围。
> - 适配决策：Raycast 的红色标点舍去（本产品无红色基因），其交互蓝
>   `hsl(202,100%,67%)` 提亮为**电光青 `#22d3ee`** 作为唯一强调色，
>   落地「电光蓝青 · 类 NVIDIA/终端感」方向（用户已确认）。
> - 色板合理性抽查：ui-ux-db `colors.csv` 深色科技/IDE/仪表盘三类样本
>   均为蓝调深底（`#0F172A` 系）+ 状态绿，与本方案同族。

## 1. Atmosphere & Identity

一个**通电的机房终端**：页面是接近纯黑但带冷蓝调的虚空（不是灰暗，是「关灯后的机架」），
电光青像设备状态灯一样只在可交互处与数据高亮处发光；网格底纹是示波器的刻度，
等宽字体的数字是仪表读数。密度上「数据页致密、公开页克制」——控制台像调音台，
落地页像深夜里一台亮着的服务器。
**签名元素**：近黑蓝底 + 电光青辉光（focus ring / 主按钮 / 关键数据）+ mono 数字读数 + 网格刻度底纹。

## 2. Color

### Palette

单一深色主题（无浅色模式；antd 走 `darkAlgorithm`）。角色与令牌：

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Canvas | `--bg` | `#07080a` | 页面底（raycast 蓝调近黑，禁用 `#000`） |
| Surface/primary | `--surface` | `#101111` | 卡片、面板、表格容器 |
| Surface/secondary | `--surface-2` | `#16181a` | 表头、hover 行、内嵌区 |
| Surface/void | `--ink` | `#050608` | 代码块/终端、品牌侧栏（比画布更深，靠边框脱出） |
| Surface/void-2 | `--ink-2` | `#0a0c0f` | 页脚、深色带 |
| Surface/void-3 | `--ink-3` | `#111417` | 深色卡片抬升 |
| Text/primary | `--text` | `#f4f7f8` | 标题、正文 |
| Text/secondary | `--text-2` | `#c3cbd1` | 描述、次要信息 |
| Text/tertiary | `--text-3` | `#9c9c9d` | 标签、占位、表格脚注 |
| Border/default | `--border` | `#23282b` | 卡片描边、分隔线 |
| Border/strong | `--border-strong` | `#33393d` | 输入框、强调分隔 |
| Border/hairline | `--border-glass` | `rgba(255,255,255,0.06)` | 深色面玻璃描边（raycast 卡片环） |
| Accent/primary | `--brand` | `#22d3ee` | 电光青：主按钮、focus、选中态、数据高亮 |
| Accent/hover | `--brand-600` | `#06b6d4` | 强调色 hover/深一档 |
| Accent/deep | `--brand-700` | `#0891b2` | 强调色按下态/深底上的强调 |
| Accent/link | `--brand-link` | `#67e8f9` | 深底上的链接文字（对 `#07080a` 约 10:1） |
| Accent/soft | `--brand-soft` | `rgba(34,211,238,0.12)` | 强调色浅底（选中行、tag 底） |
| Accent/softer | `--brand-softer` | `rgba(34,211,238,0.06)` | hover 浅底、图表底 |
| Status/ok | `--ok` | `#5fc992` | 成功（raycast 绿） |
| Status/warn | `--warn` | `#ffbc33` | 警告（raycast 黄） |
| Status/err | `--err` | `#ff6363` | 错误/危险（raycast 红） |
| Ink text | `--ink-text` | `#eef2f5` | 深色面上的正文 |
| Ink text-2 | `--ink-text-2` | `#9aa6bd` | 深色面上的次要文字 |

渐变（数据可视化 / Hero 强调，唯一允许的彩色渐变）：

```css
--grad-brand: linear-gradient(96deg, #22d3ee 0%, #38bdf8 55%, #818cf8 100%);
--grad-bar:   linear-gradient(180deg, #22d3ee, #38bdf8);   /* 柱状图/进度条 */
```

辉光（科技感核心，仅用于交互态与关键数据，不作装饰滥用）：

```css
--glow-brand: 0 0 24px rgba(34, 211, 238, 0.35);   /* 主按钮/焦点辉光 */
--glow-soft:  0 0 12px rgba(34, 211, 238, 0.18);   /* 数据高亮微光 */
```

### Rules
- 强调色只用于**可交互元素与关键数据**；整版彩色渐变仅限 `--grad-brand` 声明的场景。
- 页面底禁止 `#000000`（蓝调是签名）；深色面之间用**明度差 + 1px 描边**分层，不靠阴影硬堆。
- 状态色只在语义处出现（成功/警告/错误），不作装饰。
- 新增颜色必须先改本表，再进代码。

## 3. Typography

### Font Stack
- Primary: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`
  （**约束**：生产 CSP 禁止外链字体，无法引入 Inter 等 web font——见 Section 8 accepted debt；以系统栈 + 排版参数逼近 raycast 质感。）
- Mono: `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`（模型名、key、价格、代码、仪表数字）

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | `clamp(34px, 5.4vw, 58px)` | 680 | 1.08 | -0.03em | 落地页 Hero |
| H1 | 26–40px（clamp） | 660 | 1.15 | -0.03em | 品牌页/登录大标题 |
| H2 | `clamp(26px, 3.4vw, 36px)` | 650 | 1.2 | -0.025em | 区块标题 |
| H3 | 15–16px | 640 | 1.4 | -0.01em | 卡片标题 |
| Body/lg | 16–17px | 400 | 1.7 | +0.2px | 落地页导语 |
| Body | 14–15px | 400/500 | 1.6 | +0.2px | 控制台正文（深底上基线用 500 增可读性） |
| Caption | 12–13px | 400/500 | 1.5 | +0.2px | 表格、辅助文字 |
| Overline | 11–12px | 650 | 1.3 | +0.1em / uppercase | eyebrow、表头标签 |
| Mono/Data | 12–13px mono | 500 | 1.6 | 0 | 数字读数，`font-variant-numeric: tabular-nums` |

### Rules
- 大标题收紧字距（负值），小标签放正字距；正文在深底上用**正向 +0.2px**（raycast 签名）。
- 数据类数字一律 mono + `tabular-nums`，禁用比例字体显示金额/用量。
- 正文字号下限 14px；正文宽度上限 ~65ch（content-limiter）。

## 4. Spacing & Layout

### Base Unit：4px

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | 图标-文字 |
| `--space-2` | 8px | 紧凑组 |
| `--space-3` | 12px | 表单字段、卡片内组 |
| `--space-4` | 16px | 卡片内边距（紧凑）、网格 gap |
| `--space-6` | 24px | 卡片默认内边距、页边距 |
| `--space-8` | 32px | 卡片组之间 |
| `--space-12` | 48px | 区块内大间距 |
| `--space-16` | 64px | 区块之间 |
| `--space-20` | 80px | 落地页区块垂直节奏 |

### Grid
- 内容最大宽 `--maxw: 1120px`，居中，`padding-inline: 24px`。
- 断点（沿用现状）：`1024px`（网格降 2 列）、`860px`（导航/分栏折叠）、`520px`（单列）。
- 控制台侧栏宽度由 antd Sider 默认（`200px` 展开 / `collapsedWidth=0` 移动端）。

### 布局契约（layout-skill：scroll ownership）
- 控制台 = **fixed-sidenav-shell**：Sider 常驻（`breakpoint="lg"` 以下收起为 0），
  **唯一滚动容器是文档本身**（Content 随文档滚动，Sider 拉伸通高）。
  外壳高度用 `min-height: 100dvh`（禁 `100vh`——iOS 地址栏跳动）。
- 公开落地页 = 文档滚动；导航 `position: sticky; top: 0`。
- 任何新页面若引入内部滚动面板，必须在本节登记其滚动归属。

## 5. Components

### 已有可复用组件
- **Logo**（`components/Logo.tsx`）：SVG 字标，`size` + `onDark` 两个 props。
- **AppLayout 壳**：Sider（品牌头 + Menu）+ Header（用户下拉）+ Content；
  滚动归属见 Section 4；深色令牌化，禁止内联 hex。
- **ErrorBoundary / ProtectedRoute / AdminRoute**：行为组件，无视觉令牌。

### 抽取组件（本轮改造建立，页面禁止重复手写）

#### StatCard
- **Structure**: `surface` 卡片 → overline 标签 → mono 大数字（tabular-nums）→ 次要行（变化/说明）
- **Variants**: `default` / `accent`（数字用 `--grad-brand` 文字渐变）
- **Spacing**: `--space-6` 内边距，标签-数字间 `--space-2`
- **States**: default / loading（骨架，非 spinner）/ empty（`—` 占位）
- **Motion**: 数值变化不做动画；hover 仅描边升 `--border-strong`

#### RankBar（排行条）
- **Structure**: 行 = 标签（截断 `text-overflow: ellipsis`，`title` 兜底）+ mono 数值；下方 6px 轨
- **Variants**: 轨底 `--surface-2`，填充 `--grad-bar`
- **States**: 空数据 → Empty simple；hover 行 → `--brand-softer` 底
- **Accessibility**: 数值在文字中可读（不只靠条长表意）

#### DailyBars（日用量柱）
- **Structure**: flex 柱阵，柱 = `--grad-bar` 圆角 4px，底对齐，`title` 含日期/tokens/请求/费用
- **States**: 无数据 → Empty；轴标签 mono 10px `--text-3`
- **Motion**: 无入场动画（数据页，motion serves meaning）

#### PageHeader
- **Structure**: H3 标题 + 可选 `--text-3` 描述 + 右侧 `cluster` 操作区
- **Spacing**: 标题-描述 `--space-2`，整块与内容间 `--space-6`

### 交互控件（antd 映射）
- 主按钮：`colorPrimary` 电光青底 + 深色文字（NVIDIA 式亮底深字），hover 提亮 + `--glow-brand`。
- 次按钮/次级：透明底 + `1px solid var(--border-glass)`。
- 表格：表头 `--surface-2` + overline 字样；行 hover `--brand-softer`；选中行 `--brand-soft` 左侧 2px `--brand` 边。
- Tag/徽标：`--surface-2` 底 + `--text-2` 字；语义 Tag 用状态色的 soft 底 + 本色字。

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120–150ms | ease-out | 按压、hover 描边/底色 |
| Standard | 200–250ms | ease-in-out | 弹窗、下拉、tab 切换（antd 默认即可） |
| Emphasis | 400ms | `cubic-bezier(0.16,1,0.3,1)` | 落地页区块入场（如使用） |

### Rules
- 只动 `transform` / `opacity` / `filter`；不动布局属性。
- 每个交互元素有 hover + active + focus（focus 用 `--brand` ring：`0 0 0 2px rgba(34,211,238,0.35)`）。
- **禁止无意义动效**：悬停不变、非交互元素飘动、纯装饰微动效 = slop，不加。
- `prefers-reduced-motion: reduce` 时关闭非必要动画。

## 7. Depth & Surface

**策略：mixed（描边为主 + 着色阴影 + 交互辉光）。**

| Level | Treatment | Use |
|-------|-----------|-----|
| L0 Void | 无阴影，`--bg` | 页面底 |
| L1 Hairline | `1px solid var(--border-glass)`（深面）或 `var(--border)`（卡片） | 卡片/面板 containment |
| L2 Ring | `0 0 0 1px rgba(255,255,255,0.06)` 外环 + `inset 0 1px 0 rgba(255,255,255,0.05)` 顶光 | 抬升卡片（raycast 双环技法） |
| L3 Lift | `0 10px 30px -12px rgba(0,0,0,0.6)` | 弹窗、下拉 |
| L4 Glow | `--glow-brand` / `--glow-soft` | 主按钮、焦点、关键数据（签名时刻） |

- 阴影必须成对（外阴影 + inset 顶光），单层黑阴影在深底上无效。
- 深色面之间靠**明度阶梯**（`#07080a → #0a0c0f → #101111 → #16181a`）分层，不靠模糊堆叠。
- 网格刻度底纹仅出现在 Hero/品牌侧栏（`background-size: 48–56px` + radial mask），控制台内容区不铺。

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA：正文对比度 ≥ 4.5:1，大字/图形 ≥ 3:1；`--text-2/#c3cbd1`、`--text-3/#9c9c9d`
  对 `#07080a` 分别约 11:1 / 7:1；`--brand-link` 约 10:1（均达标）。
- 主按钮电光青底 + `#061016` 深字（> 10:1），不用白字压亮青。
- 每个交互元素有可见 focus ring（`--brand`）；全键盘可达；状态不只靠颜色（附文字/图标）。
- 尊重 `prefers-reduced-motion`（Section 6）。
- 375px 宽下重排为单列，主内容无横向滚动（表格容器 `overflow-x: auto` 属预期）。

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| 无自定义 display 字体（系统栈） | 全站 | 生产 CSP（nginx）禁止外链字体；引入打包字体增大包体 | 如需品牌字，本地打包 woff2 子集后移除 |
| antd 整包 ~1MB（gzip ~330kB） | `vite.config.ts` | rc-*/cssinjs 循环依赖无法拆分（配置内有注释说明） | 保持现状，阈值 1100kB |
| 页面内残留 `style={{}}` 内联样式 | 各控制台页 | 逐页收编中；一次性迁移风险过高 | 每次触及该页时收编进类/令牌 |
| `react-scan/auto` 子路径不可用 | `main.tsx` DEV 分支 | 上游 0.5.7 exports 指向未发布的 `dist/auto.mjs`；已改用根入口 `import('react-scan').then(m => m.scan())` | 上游修复后可切回 `/auto` |
| React dev 工具链入依赖 | `package.json`（react-grab/react-scan/react-doctor） | frontend 技能强制 dev-only 门控安装；已在 `import.meta.env.DEV` 下动态导入 | 若团队不认可可移除 |
