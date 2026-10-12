# B 站按时间过滤

这是一个同时提供 Tampermonkey 用户脚本和 Chrome MV3 扩展的 B 站时间过滤工具。它按本地截止时间 `T` 严格保留发布时间早于 `T` 的当前内容；无法确认时间的内容会隐藏。过滤范围和边界见 [`CONTEXT.md`](CONTEXT.md)。

## 构建

需要 Node.js 和 npm。安装依赖后运行：

```powershell
npm install
npm run build
```

发布产物位于：

- `dist/userscript/bilibili-time-filter.user.js`
- `dist/extension/`

开发排查版本会自动输出脱敏控制台日志，构建命令为：

```powershell
npm run build:dev
```

开发产物位于 `dist/dev/userscript/` 和 `dist/dev/extension/`。日志使用 `[时光机]` 前缀，记录配置、原生日期范围、网络过滤统计、逐卡判定和补请求状态，不上传数据。

## 使用

在 B 站支持页面打开页面内的“时光机”面板，设置本地截止日期和时间后启用过滤。支持的主机包括：

- `www.bilibili.com`
- `search.bilibili.com`
- `space.bilibili.com`
- `t.bilibili.com`

安装用户脚本时加载 `dist/userscript/bilibili-time-filter.user.js`。安装扩展时在 Chrome 的开发者模式中加载 `dist/extension/`，然后刷新 B 站页面。

## 验证

```powershell
npm run typecheck
npm test -- --run
```

当前构建还提供以下单独命令：

```powershell
npm run build:userscript
npm run build:extension
npm run build:userscript:dev
npm run build:extension:dev
```

发布构建不包含项目诊断日志；开发构建只向当前浏览器控制台输出脱敏日志。
