'use strict';
const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');
module.exports = {
    target: 'node',
    entry: './src/extension.ts',
    output: { path: path.resolve(__dirname, 'dist'), filename: 'extension.js', libraryTarget: 'commonjs2', clean: true },
    externals: { vscode: 'commonjs vscode', './compat/kiro-chat-compat': 'commonjs ./kiro-chat-compat.js' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }] },
    plugins: [new CopyPlugin({ patterns: [
        { from: 'src/chat/webview', to: 'webview', info: { minimized: true } },
        { from: 'src/compat/*.js', to: '[name][ext]', info: { minimized: true } },
    ] })],
    devtool: 'source-map',
};
