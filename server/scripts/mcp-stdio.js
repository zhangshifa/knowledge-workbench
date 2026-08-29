#!/usr/bin/env node
// 入站 MCP 服务端启动器：把本知识库作为 MCP 资源暴露给 Agent / IDE。
// 用法（在 MCP 客户端配置中）：
//   { "mcpServers": { "knowledge-workbench": { "command": "node", "args": ["server/scripts/mcp-stdio.js"], "env": { "KB_DATA_DIR": "./data" } } } }
import { runStdio } from '../src/mcp/server.js';
runStdio();
