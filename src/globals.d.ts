/**
 * Vite 构建时注入的编译常量：
 * - 发布构建（dist/userscript、dist/extension）为 `false`；
 * - 开发构建（dist/dev/**）为 `true`，自动启用脱敏诊断日志。
 */
declare const __TIME_FILTER_DEV__: boolean;
