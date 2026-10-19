# Attribution

This is an unofficial personal modification of the MIT-licensed VS Code extension by Asad Bin Imtiaz:
https://github.com/AsadBinImtiaz/kiro-vscode-extension

Base version: 0.1.3. The original copyright and license text is preserved in LICENSE.md.

Personal changes include ACP V2/V3 compatibility, a secondary-sidebar view, native conversation history, IDE-style chat UI, permission handling, file attachments, credit usage, standalone identifiers, CLI discovery and a device-authorization terminal.

Marked and DOMPurify are redistributed with their license texts in dist/webview/vendor/. Kiro CLI is not bundled. Kiro and AWS names identify the services with which this extension interoperates; this package is not an official AWS or Kiro release.

The upstream TypeScript sources were verified against the source map of the deployed base version 0.1.3. Upstream reference commit: cb4da49b04371f7fed96976a24d20e5cff9a6d4d. Local changes to the core add isolated extension identifiers, CLI start options and compatibility module installation.

Additional dependency: ignore 7.0.5 (MIT), bundled by webpack. Its license is included in THIRD_PARTY_NOTICES.md.
