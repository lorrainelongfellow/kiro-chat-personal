# Kiro Chat Personal

[下载最新安装包](https://github.com/lorrainelongfellow/kiro-chat-personal/releases/latest) · [提交问题](https://github.com/lorrainelongfellow/kiro-chat-personal/issues) · [参与开发](CONTRIBUTING.md)

Kiro CLI 的非官方 VS Code 侧栏扩展，基于 Asad Bin Imtiaz 的 MIT 许可扩展进行个人改造。需要单独安装 Kiro CLI。本扩展不由 AWS 或 Kiro 官方发布。

包含 IDE 风格聊天界面、CLI 原生模型与思考强度、模式与 Autopilot、浮动历史菜单、附件与编辑器上下文、Markdown 与代码复制、工具确认与停止生成，以及账户积分查询。

模型、选项和积分来自本机 CLI；界面样式和中文说明由扩展实现。积分属于官方估算用量，查询失败时显示未获取。安装包不包含 CLI、账户凭据、浏览器 Cookie、个人对话或工程文件。

## 安装与开始

1. 使用 VS Code 1.142.0 或更高版本；这是此次验证的版本。
2. 从 https://kiro.dev/downloads/ 安装 Kiro CLI。此次验证版本为 2.32.0。
3. 在 VS Code 扩展面板的 `…` 菜单中选择“从 VSIX 安装”，从 [Releases](https://github.com/lorrainelongfellow/kiro-chat-personal/releases/latest) 下载并选择 `kiro-chat-personal-1.1.3.vsix`。
4. 执行 `Kiro Personal: Open Chat`。扩展使用当前 Windows 用户的 CLI 登录状态。
5. 尚未登录时运行 `Kiro Personal: Login`，终端会显示授权地址与设备码。手动在新的 Chrome 无痕窗口中打开地址并完成 AWS Builder ID 授权。此入口使用设备授权，不自动打开普通浏览器。

Windows 自动查找 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`、`%USERPROFILE%\.local\bin\kiro-cli.exe` 和 PATH。也可在设置 `kiroPersonal.cliPath` 填写 CLI 的绝对路径；该设置只属于当前电脑。

模型更新仅在点击模型搜索框旁的“刷新”时检查，没有定时轮询，也没有启动时额外检查。聊天初始化正常读取 CLI 提供的模型列表，反复打开模型下拉框不触发检查。手动刷新会在当前任务结束后重新连接原生会话并刷新选项；保留对话、当前可用模型、强度、模式、Autopilot 和未发送草稿，并显示新增模型提示。列表始终以 CLI 实际提供的选项为准，不硬编码未来模型；如果模型需要新版 CLI 才能识别，仍需另行升级 CLI。

上次手动检查时看到的模型 ID 按账户保存在本机 `~/.kiro/vscode-chat-models.json`，供下次手动刷新判断新增条目；该文件不保存登录令牌，也不包含在安装包中。

命令还包括 `Kiro Personal: Restart CLI` 和 `Kiro Personal: Start Spec`。模型、强度、模式、Autopilot 和积分均按当前 CLI 的能力显示。Kiro IDE 完整 Artifacts 工作流与代码差异审批不在本扩展范围内。

如果同时装了原版 Kiro，建议停用原版，使用 Personal 版本以免出现两个 Kiro 侧栏。两者扩展标识、命令、视图及界面状态目录互相独立。独立版安装时不会覆盖原版扩展。

## 账户与历史

每台电脑需单独安装 CLI 并登录自己的账户。扩展不把账户密码写入配置，也不把登录凭据打包。点击顶部邮箱打开“账户管理”，可核对账户、登录、退出或“退出并重新登录”。设备码授权需手动在新的 Chrome 无痕窗口完成，不自动打开普通浏览器。菜单管理本机 CLI 登录，使用相同凭据的其他窗口也会受影响。

对话内容由 CLI 原生存储管理；本扩展仅将标题与选中的会话记录在 `~/.kiro/vscode-chat-personal/ui-state.json`。本地历史不会随 VS Code 设置同步自动上传。CLI 原生存储中已有的本工作区历史会显示在历史菜单中。

历史菜单中每个对话支持重命名、置顶／取消置顶、导出 Markdown 和删除。标题和置顶仅保存于本机 UI 状态，不修改 CLI 原生对话内容。导出包含可恢复的用户、Kiro 文本和工具标题；导出其他历史不会切换当前对话。

批量删除：打开历史菜单 → “多选”，勾选记录，或点击“全选当前筛选结果”，再点击“删除所选”。全选只影响当前搜索匹配的记录；切换搜索仍保留已选项，“已选”显示总数。退出多选会清空选择。批量只确认一次，失败项会显示原因并保留可重试的选择；不新增后台检查。

删除需要确认，通过 CLI 原生命令永久删除对应的本机历史记录，并清理标题、置顶和会话指针；不是仅从列表隐藏。删除当前对话时先打开新对话、释放旧连接，保留未发送草稿。若删除失败且原记录仍存在，会尝试恢复原对话；其他窗口占用时可能无法删除。生成回复或连接操作期间不允许删除。删除不会撤销对话已经造成的工程文件改动。

## 版本、连接与本轮改动

顶部 `ⓘ` 打开版本与连接诊断，显示插件和改造版本、实际 CLI 路径与版本、账户、会话连接、引擎和模型数量。点击“检查 CLI 更新”才访问 Kiro 官方稳定版清单；不定时检查，不下载或安装升级。诊断还提供重新连接、复制诊断以及使用实际路径的 CLI 升级命令。插件仍通过 VSIX 手动更新。

顶部“改动”显示最近一轮任务涉及的文件，支持打开文件和 VS Code 只读差异视图。Git 工作区比较本轮开始前与结束后的文件内容；已有未提交修改会作为开始基线，而非直接与 HEAD 比较。列表也可能包含同期手动编辑。无 Git 基线时仅收集 CLI 报告的路径或差异片段，界面会标明覆盖范围。

快照仅在发送任务前后及 CLI 工具事件时收集，没有后台轮询或空闲文件扫描。每轮最多列出 200 个文件，单文件文本快照上限 1 MiB、收集预算 16 MiB；大文件、二进制或缺失基线时显示原因。内存保留最近 5 个会话各自的最后一轮，重载后清空，不提供自动接受、撤销或历史快照恢复。

积分在账户栏显示，点开可查看套餐、本月已用／总额、剩余、比例和重置日期。打开面板与回复结束后自动刷新，也可手动刷新。当前 CLI 的 V3 未开放积分查询时，使用同一 CLI 的 V2 原生 `usage` 命令读取结构化结果；该查询不向模型发送提示。

## 本对话自动允许

工具确认框保留“本次允许”“本次拒绝”“取消”，并增加“本对话始终允许”。点击后，当前对话后续可单次允许的 CLI 工具请求会自动确认，已等待的可允许请求也会一并处理。界面持续显示启用状态，可点击“恢复逐次确认”立即关闭。

这是插件内存中的会话选择：不发送 CLI 的永久允许选项，不修改全局权限或 Autopilot。新建或切换对话、CLI 重连、退出／切换账户、重载 VS Code 后失效。CLI 未提供单次允许选项的请求仍需处理，CLI 的拒绝规则不被修改。停止当前生成会取消尚未回答的工具请求。

## 来源与许可

基础扩展：https://github.com/AsadBinImtiaz/kiro-vscode-extension ，原基础版本 0.1.3。

保留原 MIT 许可及第三方 Markdown／HTML 清理库的许可，详见 `LICENSE.md`、`NOTICE.md` 与 `dist/webview/vendor/`。

本地扩展标识为 `local-kiro-tools.kiro-chat-personal`。`local-kiro-tools` 是离线打包用标识，不表示已注册的 Marketplace 发布者。本项目通过 GitHub Releases 发布 VSIX，尚未发布到 VS Code Marketplace。安装 VSIX 不会自动从 GitHub 更新，后续请下载新的安装包升级。

## 从源码构建

需要 Node.js 22.15 或更高版本及 npm。

```bash
git clone https://github.com/lorrainelongfellow/kiro-chat-personal.git
cd kiro-chat-personal
npm ci
npm run check
npm run build
npm run package
```

运行和开发说明见 [开发文档](docs/DEVELOPMENT.md)。仓库包含 TypeScript 基础源码、全部可读的 JavaScript 兼容模块与聊天界面；构建会重新生成 `dist/`，无需手工修改压缩代码。Kiro CLI 需另外安装。当前验证平台为 Windows，其他平台尚未做完整验证。
