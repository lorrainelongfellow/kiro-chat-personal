# 开发与构建

## 环境

- Node.js 22.15+、npm，运行扩展需要 VS Code 1.142.0+。
- 单独安装 Kiro CLI；当前验证版本为 2.32.0。运行聊天需要本机 CLI 完成登录。
- 首次安装依赖使用 `npm ci`，锁文件随仓库提供。

## 命令

`npm run check` 检查 TypeScript 类型和 JavaScript 语法。`npm test` 在临时 Git 工作区验证超过 200 个候选文件、真实变化列表截断、文本预算和二进制预算的计数行为，不调用模型。`npm run build` 通过 webpack 生成扩展主程序，复制兼容模块和 Webview 静态文件。`npm run package` 会先构建再生成 VSIX，安装包不包含开发源码和依赖目录。

## 目录

- `src/extension.ts`：入口，在创建实例前安装兼容模块。
- `src/cli/`、`src/chat/`、`src/context/`、`src/spec/`：基于上游 MIT 项目的 TypeScript 基础实现。
- `src/compat/`：ACP、模型、历史、账户、用量、权限和文件改动等改造。
- `src/chat/webview/`：HTML、CSS、聊天交互和带许可的前端库。
- `dist/`：自动生成的运行文件，不提交 Git。

兼容模块保留为独立 CommonJS 文件，由入口显式加载。它们依赖基础类的部分内部字段，因此升级上游实现时需检查接口和行为，不能直接覆盖基础源码。

## 本次发布验证

类型、语法、完整构建、VSIX 内容和源码隐私检查；历史单条／批量删除、确认取消、部分失败和当前对话替代；真实临时会话与无头浏览器布局。真实测试不发送模型提示，不删除用户现有历史。

## 发布

提高 `package.json` 与 `src/compat/kiro-chat-management.js` 中的改造版本，更新 CHANGELOG。执行构建、检查和必要验证，生成 VSIX 与 SHA-256 校验文件后，将安装包放到 GitHub Release。不要提交凭据、设备码、个人历史或本机 UI 状态。

当前不包含自动更新、发布工作流或定时检查。开源仓库和 VS Code Marketplace 是两个独立发布渠道。
