# Zotero Backend 使用指南

## 概述

Zotero Backend 提供统一的 Zotero 访问层，支持两种后端：

| 后端 | 场景 | 依赖 |
|------|------|------|
| **Web API** | 无桌面端、服务器环境 | Zotero 账号 + API Key |
| **CLI** | 桌面端环境 | cli-anything-zotero (zotero-cli) |

**降级链**：Web API 失败时自动降级到 CLI。

## 快速开始

### Web API 模式（无桌面端）

```bash
# 设置环境变量
export ZOTERO_USER_ID="your_user_id"
export ZOTERO_API_KEY="your_api_key"

# 使用
node -e "
  import('./workflow/tools/lib/zotero_backend_integration.mjs').then(async (m) => {
    await m.initZoteroBackend();
    const adapter = m.getAdapter();
    const collections = await adapter.getCollections();
    console.log(collections);
  });
"
```

### CLI 模式（桌面端）

```bash
# 安装 cli-anything-zotero
npm install -g cli-anything-zotero

# 确保 Zotero 桌面端正在运行

# 使用
node -e "
  import('./workflow/tools/lib/zotero_backend_integration.mjs').then(async (m) => {
    await m.initZoteroBackend({ preferredBackend: 'cli' });
    const adapter = m.getAdapter();
    const collections = await adapter.getCollections();
    console.log(collections);
  });
"
```

### 自动模式（推荐）

```bash
# 有 API Key 和所选文库 ID 时用 Web API，否则用 CLI
node -e "
  import('./workflow/tools/lib/zotero_backend_integration.mjs').then(async (m) => {
    const result = await m.initZoteroBackend(); // auto 模式
    console.log('Backend:', result.backend);
    console.log('Fallback used:', result.fallbackUsed);
  });
"
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ZOTERO_USER_ID` | 个人文库的数字 User ID | Web API 必填 |
| `ZOTERO_API_KEY` | 具有个人文库写权限的 Zotero API Key | Web API 必填 |
| `ZOTERO_API_BASE` | API 基础 URL，仅测试/开发覆盖 | `https://api.zotero.org` |
| `ZOTERO_WEB_CLI_TOOL` | headless CLI 工具名 | `zot` |
| `ZOTERO_DESKTOP_CLI_TOOL` | desktop CLI 工具名 | `zotero-cli` |
| `ZOTERO_BACKEND` | 后端选择 | `auto` |

### ZOTERO_BACKEND 可选值

- `auto`：API Key 与个人文库 User ID 都存在时用 Web API，否则用 CLI（默认）
- `web_api`：强制使用 Web API
- `cli`：强制使用 CLI

正式 Web 请求固定使用 `Zotero-API-Version: 3` 和 `Zotero-API-Key` 请求头；API Key 不进入 URL 或日志。PaperEcho v2.4 使用个人文库 `/users/<User ID>`；Zotero 官方虽定义群组文库 URL，本版本不在设置页提供该能力。

## API 方法速查

### 连接管理

```javascript
adapter.ping()                    // 检查后端是否可用
adapter.ensureReady(options)      // 确保后端就绪（含重试）
adapter.getDiagnostics()          // 获取诊断信息
```

### 集合读取

```javascript
adapter.getCollections(options)                    // 获取集合列表
adapter.getSubcollections(collectionKey, recursive) // 获取子集合
adapter.getCollectionItems(collectionKey, options)  // 获取集合中的项目
```

### 集合写入（带 verify）

```javascript
adapter.createCollection(name, parentKey)                              // 创建集合
adapter.deleteCollection(collectionKey, options)                        // 删除集合
adapter.addItemsToCollection(itemKeys, collectionKey, options)          // 添加项目到集合
adapter.removeItemsFromCollection(itemKeys, collectionKey, options)     // 从集合移除项目
adapter.verifyItemsInCollection(itemKeys, collectionKey, options)       // 验证项目是否在集合中
adapter.moveItemsBetweenCollections(itemKeys, from, to, options)        // 在集合间移动项目
adapter.ensureCollectionPath(pathArray, options)                        // 确保集合路径存在
```

### 项目读取

```javascript
adapter.getItemDetails(itemKey, mode)   // 获取项目详情
adapter.searchLibrary(options)          // 搜索库
```

### 项目写入

```javascript
adapter.createItem(itemData)        // 创建项目
adapter.updateItem(itemKey, fields) // 更新项目
adapter.writeTag(options)           // 写入标签
adapter.writeMetadata(itemKey, fields) // 写入元数据
```

## 兼容层（mcpToolCall）

现有代码可通过兼容层使用新后端：

```javascript
import { createCompatMcpToolCall } from "./workflow/tools/lib/zotero_backend_compat.mjs";

const mcpToolCall = await createCompatMcpToolCall();

// 与原有 mcpToolCall 接口一致
const result = await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 1);
```

## 错误处理

### 版本冲突

Web API 后端在并发修改时会抛出版本冲突错误。处理方式：

```javascript
try {
  await adapter.updateItem(itemKey, { title: "new title" });
} catch (error) {
  if (error.message.includes("412") || error.message.includes("Precondition Failed")) {
    // 版本冲突，重新获取最新版本后重试
    const latest = await adapter.getItemDetails(itemKey);
    await adapter.updateItem(itemKey, { ...fields, version: latest.version });
  }
}
```

### 降级链

```javascript
const result = await initZoteroBackend();
if (result.fallbackUsed) {
  console.log("降级原因:", result.fallbackReason);
}
```

## 从 MCP 迁移

### 步骤 1：替换 mcpToolCall

```javascript
// 旧代码
const result = await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 1);

// 新代码（兼容层）
import { createCompatMcpToolCall } from "./workflow/tools/lib/zotero_backend_compat.mjs";
const mcpToolCall = await createCompatMcpToolCall();
const result = await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 1);

// 新代码（直接使用）
import { getZoteroAdapter } from "./workflow/tools/lib/zotero_adapter.mjs";
const adapter = await getZoteroAdapter();
const result = await adapter.getCollections({ mode: "complete", limit: 1000 });
```

### 步骤 2：移除 MCP 依赖

确认所有代码都已迁移后，可以移除：
- `ensure_zotero_backend_ready.mjs`（旧入口）
- MCP 相关环境变量

## 文件结构

```
workflow/tools/lib/
  zotero_backend_base.mjs        # 后端基类（接口定义）
  zotero_web_api_backend.mjs     # Web API 后端实现
  zotero_cli_backend.mjs         # CLI 后端实现
  zotero_adapter.mjs             # 适配层（自动选择 + 降级）
  zotero_backend_compat.mjs      # mcpToolCall 兼容层
  zotero_backend_integration.mjs # 集成入口
  zotero_cli_executor.mjs        # CLI 命令执行器
  ensure_zotero_backend_ready.mjs # 新 readiness 检查入口
```
