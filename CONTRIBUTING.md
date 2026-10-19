# 参与开发

欢迎提交 Issue 和 Pull Request。请说明 VS Code、操作系统、扩展及 CLI 版本、复现步骤和实际结果，日志需移除账户邮箱、设备授权码、令牌和工程内容。

开发环境、构建与模块说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。提交前运行 `npm ci`、`npm run check` 和 `npm run build`，并验证变更相关行为。

模型、强度、模式和额度必须取自 CLI 实际返回，不能硬编码可用能力或伪造用量。模型与 CLI 升级检查保持手动触发，不新增后台轮询。保留 MIT 与第三方许可，明确这是非官方扩展。
