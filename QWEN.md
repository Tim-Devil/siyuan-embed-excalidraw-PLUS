# SiYuan Embed Excalidraw PLUS 项目上下文

## 项目概述

这是一个 **思源笔记 (SiYuan) 插件** 的独立 PLUS 分支，用于在思源笔记中嵌入 Excalidraw 绘图功能。插件允许用户直接在思源笔记中创建和编辑高质量的 SVG/PNG 矢量图形，所有编辑信息直接嵌入到图像文件中，确保内容可移植和可分享。

### 核心技术栈

- **框架**: React 19 + TypeScript
- **构建工具**: Vite 6
- **包管理器**: pnpm
- **核心库**: 
  - `@excalidraw/excalidraw` - Excalidraw 绘图引擎
  - `siyuan` - 思源笔记插件 SDK
  - `@zumer/snapdom` - iframe 内容捕获为 SVG
  - `vditor` - Markdown 编辑器
- **代码规范**: ESLint (@antfu/eslint-config)

### 项目架构

```
siyuan-embed-excalidraw-PLUS/
├── src/                    # 插件主入口和工具函数
│   ├── index.ts           # 插件主逻辑 (ExcalidrawPlugin 类)
│   ├── index.scss         # 插件样式
│   ├── default.json       # 默认占位图像内容 (SVG/PNG)
│   ├── i18n/              # 国际化文件 (en_US.json, zh_CN.json)
│   ├── types/             # TypeScript 类型定义
│   │   └── index.d.ts     # 思源笔记相关类型定义
│   └── utils/             # 通用工具函数
│       ├── index.ts       # DOM 操作、数据转换、PNG/SVG 处理等
│       ├── fetch.ts       # 思源 API 请求封装
│       ├── hotkey.ts      # 快捷键处理
│       └── task.ts        # 任务调度工具
├── app/                    # Excalidraw 编辑界面
│   ├── app.tsx            # React 编辑组件 (核心编辑逻辑)
│   ├── app.scss           # 编辑界面样式
│   ├── index.html         # 编辑界面入口
│   ├── types.d.tsx        # 编辑界面类型定义
│   └── utils/             # 编辑界面工具函数
│       └── iframeCapture.ts  # iframe 捕获为图像 (支持思源块嵌入和 Markdown 元素)
├── embed/                  # 嵌入内容
│   ├── siyuan/            # 思源块嵌入界面
│   │   ├── index.html     # 思源块嵌入入口
│   │   └── index.ts       # 加载思源块并隐藏 UI 元素
│   └── markdown/          # Markdown 编辑器
│       ├── index.html     # Markdown 嵌入入口
│       ├── index.ts       # Vditor 编辑器初始化
│       ├── utils.ts       # 工具函数（访问父页面 API）
│       ├── types.ts       # TypeScript 类型定义 (MarkdownData, MarkdownConfig)
│       └── vditor/        # Vditor 静态资源 (CDN 镜像)
├── assets/                 # 静态资源
├── plugin.json            # 思源插件配置文件
├── vite.config.ts         # 插件主构建配置
├── vite.app.config.ts     # 编辑界面构建配置
├── vite.embed-siyuan.config.ts  # 思源嵌入界面构建配置
└── vite.embed-markdown.config.ts # Markdown 嵌入界面构建配置
```

## 构建与运行

### 环境准备

1. 安装依赖:
```bash
pnpm install
```

2. 配置思源工作空间路径:
```bash
# 复制环境变量示例文件
cp .env.example .env
# 编辑 .env 文件，设置 VITE_SIYUAN_WORKSPACE_PATH
```

### 开发命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 构建插件并监听变化 (开发模式) |
| `pnpm dev:app` | 构建编辑界面 (开发模式) |
| `pnpm dev:embed-siyuan` | 构建思源嵌入界面 (开发模式) |
| `pnpm dev:embed-markdown` | 构建 Markdown 嵌入界面 (开发模式) |
| `pnpm build` | 完整构建所有模块 |
| `pnpm build:app` | 仅构建编辑界面 |
| `pnpm build:embed-siyuan` | 仅构建思源嵌入界面 |
| `pnpm build:embed-markdown` | 仅构建 Markdown 嵌入界面 |
| `pnpm build:plugin` | 仅构建插件主体 |
| `pnpm build:excalidraw-fork` | 从固定补丁重新构建带本机字体支持的 Excalidraw 包 |

## 开发规范

### 代码风格

- **缩进**: 2 空格
- **引号**: 单引号
- **类型系统**: TypeScript (严格模式部分启用)
- **导入顺序**: 使用 `@antfu/eslint-config` 规范

### 项目约定

1. **路径别名**:
   - `@/` 指向 `src/` 目录
   - `@/libs/*` 指向 `src/libs/*` 目录

2. **国际化**: 所有用户可见文本应使用 `this.i18n` 访问，支持中英文

3. **思源插件生命周期**:
   - `onload()`: 插件加载时初始化
   - `onunload()`: 插件卸载时清理
   - `openSetting()`: 打开设置界面

4. **图像存储格式**: 支持 SVG 和 PNG 两种格式，SVG 格式将场景数据嵌入图像元数据中

## 核心功能模块详解

### 1. 插件主体 (src/index.ts)

**ExcalidrawPlugin 类** 是插件的核心，负责：

- **平台检测**: 检测运行环境 (桌面端/移动端/浏览器/本地)
- **图像块监听**: 使用 `MutationObserver` 监听新插入的图片块，识别 `excalidraw-` 开头的图片
- **编辑按钮注入**: 为合法的 Excalidraw 图片添加编辑按钮
- **命令注册**: 注册 `/excalidraw` 命令创建新图像
- **快捷键处理**: 支持创建 Excalidraw 图像的快捷键
- **设置界面**: 提供配置项（标签显示、存储格式、编辑窗口模式、主题、自动保存等）

**关键方法**:
- `setAddImageBlockMuatationObserver()`: 设置图片块监听器
- `getExcalidrawImageInfo()`: 获取图像信息并验证是否为 Excalidraw 图像
- `newExcalidrawImage()`: 创建新的 Excalidraw 图像
- `openEditTab()`: 在 Tab 中打开编辑界面
- `openEditDialog()`: 在 Dialog 中打开编辑界面

### 2. 编辑界面 (app/app.tsx)

**核心组件 App** 负责：

- **Excalidraw 初始化**: 加载图像数据并初始化 Excalidraw 实例
- **保存逻辑**: 
  - 手动保存：捕获所有 iframe 渲染为图像后保存
  - 自动保存：仅更新元数据，避免 iframe 抖动
- **iframe 捕获**: 使用 `snapdom` 库将 iframe 内容捕获为 SVG 图像
- **嵌入内容渲染**: 支持思源块嵌入和 Markdown 编辑器

**保存流程**:
1. `captureAllIframes()`: 捕获所有需要处理的 iframe (思源块嵌入、Markdown 元素)
2. `replaceIframesWithImages()`: 将 iframe 元素替换为矩形背景 + SVG 图像
3. `exportToSvg()` / `exportToBlob()`: 导出处理后的图像
4. 通过思源 API 保存到 `data/assets/` 目录

**关键特性**:
- 支持明暗主题切换
- 支持全屏编辑
- 支持自定义代码片段 (CSS/JS)
- 支持嵌入思源块和 Markdown 编辑器

### 3. iframe 捕获 (app/utils/iframeCapture.ts)

**核心功能**:
- `needsIframeCapture()`: 判断元素是否需要 iframe 捕获 (思源块嵌入、Markdown 元素)
- `getIframeForElement()`: 获取对应的 iframe 元素
- `captureIframe()`: 使用 `snapdom.toSvg()` 将 iframe 内容捕获为 SVG
- `captureAllIframes()`: 批量捕获所有 iframe，带缓存机制
- `replaceIframesWithImages()`: 将 iframe 元素替换为图像

**缓存机制**:
- 使用 `embedIframeVersionNonce` 判断 iframe 内容是否变化
- 避免重复捕获，提升性能

### 4. 思源块嵌入 (embed/siyuan/index.ts)

**功能**: 在 Excalidraw 中嵌入思源笔记块

**实现方式**:
- 通过 iframe 加载思源块页面 `/stage/build/desktop/?id={blockID}`
- 使用 CSS 隐藏思源页面的 UI 元素（工具栏、状态栏、侧边栏等）
- 只保留块内容本身

**CSS 隐藏的元素**:
```css
#toolbar, #status, #message,
#dockBottom, #dockLeft, #dockRight,
.layout__dockl, .layout__dockr,
.protyle-breadcrumb,
.protyle-top >:not(.protyle-title),
.protyle-content >:not(.protyle-top):not(.protyle-wysiwyg),
...
```

### 5. Markdown 编辑器 (embed/markdown/)

**文件结构**:
- `index.ts`: Vditor 编辑器初始化
- `utils.ts`: 与父页面 (Excalidraw) 通信的工具函数
- `types.ts`: TypeScript 类型定义

**数据结构**:
```typescript
// 存储在 Excalidraw embeddable 元素的 customData.embedMarkdown 中
interface MarkdownData {
  content: string;                        // Markdown 内容
  config: MarkdownConfig;                 // 编辑器配置
}
```

**通信机制**:
- `embed/markdown` 直接访问父页面的 `window.parent.excalidrawAPI`
- 不需要 postMessage 中转，直接调用 API 更新元素数据
- 数据流：`embed/markdown/utils.ts` → `window.parent.excalidrawAPI.updateScene()`

**判断方式**:
```typescript
// 判断是否为 Markdown 元素：检查 customData.embedMarkdown 是否存在
if (element?.customData?.embedMarkdown) {
  // 这是 Markdown 元素
}
```

**更新机制**:
- 输入防抖 300ms
- 更新时同步更新 `embedIframeVersionNonce` 触发重新捕获
- 更新元素版本号和更新时间

### 6. 工具函数 (src/utils/index.ts)

**主要功能**:

**DOM 操作**:
- `HTMLToElement()`: HTML 字符串转 DOM 元素
- `escapeHTML()` / `unescapeHTML()`: HTML 转义/反转义
- `addStyle()` / `addScript()`: 动态加载样式/脚本

**数据转换**:
- `unicodeToBase64()` / `base64ToUnicode()`: Unicode 与 Base64 互转
- `dataURLToBlob()` / `blobToDataURL()`: DataURL 与 Blob 互转
- `blobToArray()` / `arrayToBase64()`: Blob/Array 与 Base64 互转

**PNG 处理**:
- `getPNGSize()`: 读取 PNG 图像尺寸
- `locatePNGtEXt()`: 定位 PNG 中的 tEXt 块
- `replaceSubArray()`: 替换 PNG 中的子数组 (用于替换元数据)
- `insertPNGpHYs()`: 插入 pHYs 块 (设置 DPI)
- `insertPNGtEXt()`: 插入 tEXt 块 (设置元数据)

**SVG 处理**:
- `getSVGSize()`: 读取 SVG 图像尺寸

**任务调度**:
- `processArraySequentially()`: 顺序处理数组 (避免阻塞主线程)

## 图像存储格式

### SVG 格式
- 使用 `metadata` 标签存储 Excalidraw 场景数据
- 格式：`<!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->{base64 编码的场景数据}<!-- payload-end -->`
- 优点：可直接查看和编辑 XML 内容，兼容性好
- 缺点：文件体积相对较大

### PNG 格式
- 使用 `tEXt` 块存储 Excalidraw 场景数据
- 通过 `locatePNGtEXt()` 定位和替换元数据
- 优点：文件体积相对较小
- 缺点：需要特殊工具查看元数据

## 配置项说明

| 配置项 | 说明 | 可选值 |
|--------|------|--------|
| `labelDisplay` | 图像块标签显示模式 | `noLabel` / `showLabelAlways` / `showLabelOnHover` |
| `embedImageFormat` | 新创建图像的存储格式 | `svg` / `png` |
| `fullscreenEdit` | 是否启用全屏编辑 | `true` / `false` |
| `editWindow` | 编辑窗口模式 | `dialog` / `tab` |
| `themeMode` | 主题模式 | `themeLight` / `themeDark` / `themeOS` |
| `snippets` | 启用的自定义代码片段 ID 列表 | `string[]` |
| `enableAutoSave` | 是否启用自动保存 | `true` / `false` |
| `autoSaveInterval` | 自动保存间隔 (秒) | `number` (最小 0) |

## 关键数据流

### 创建图像流程
1. 用户输入 `/excalidraw` 命令
2. 插件调用 `newExcalidrawImage()` 创建占位图像
3. 上传占位图像到 `data/assets/` 目录
4. 根据配置打开 Tab 或 Dialog 编辑界面
5. 用户在 Excalidraw 中绘制内容
6. 保存时捕获所有 iframe 并导出图像
7. 通过思源 API 保存图像

### 编辑已有图像流程
1. 用户点击图像右上角编辑按钮或右键菜单
2. 插件调用 `getExcalidrawImageInfo()` 验证并加载图像
3. 解析图像中的元数据 (SVG metadata 或 PNG tEXt)
4. 加载 Excalidraw 场景数据
5. 用户编辑内容
6. 保存流程同创建图像

### Markdown 编辑流程
1. 用户在 Excalidraw 中点击"嵌入网页"，输入 Markdown 元素
2. Excalidraw 创建 embeddable 元素，设置 `customData.embedMarkdown`
3. `embed/markdown` 通过 `getElementData()` 从父页面获取数据
4. 初始化 Vditor 编辑器
5. 用户输入内容，防抖后调用 `updateElementData()` 更新
6. 更新触发 `embedIframeVersionNonce` 变化
7. 保存时 `captureAllIframes()` 检测到变化，重新捕获 iframe

## 注意事项

- 插件使用 `process.env.DEV_MODE` 区分开发和生产模式
- 开发模式下会自动监听文件变化并重新加载
- 发布时会自动生成 `package.zip` 文件
- 思源工作空间路径必须正确配置才能在开发模式下使用
- 只识别以 `excalidraw-` 开头的图片以优化文档加载速度
- 嵌入的思源块和 Markdown 编辑器在保存时会被捕获为静态图像
