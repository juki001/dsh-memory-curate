# 记忆浏览器 UI 集成说明

本文件记录 `src/browser-routes.js`（宿主路由）与 `src/ui/client.js`（设置页记忆面板）如何接入，以及运行时如何降级。

## 1. package.json

```json
"exports": {
  ".": "./src/index.js",
  "./client": "./src/ui/client.js"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

- `dsh.client.platform` 必须是 `"web"`，且 `exports["./client"]` 必须存在，宿主 `@deepseek-ai/dsh-client-modules` 才会加载客户端包。
- `inject` 留空：面板只消费宿主提供的 `slots` 服务，与 billion-context 的 `{ "platform": "web" }` 一致。
- 不需要新增端口或 `cordis.patch.yml` 条目：客户端 bundle 由 DSH 客户端加载器提供，HTTP 路由复用宿主 `webServer`。

## 2. src/index.js

`apply()` 中在 `service.storeError` 之后调用一次：

```js
const memoryRoutes = registerMemoryRoutes(ctx, service)
if (!memoryRoutes.ok) ctx.logger?.warn?.(`memory-curate: memory browser routes unavailable: ${memoryRoutes.error}`)
```

`registerMemoryRoutes` 内部用 `ctx.inject(['webServer'], ...)` 延迟挂载，**不要**把 `webServer` 写进插件 `inject`：CLI-only profile 没有 Web 服务，静态注入会让插件加载不上。

## 3. 路由

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---|---|
| GET | `/plugins/dsh-memory-curate/status` | loopback Host + peer + Origin/Sec-Fetch-Site；不要求 key（签发者） | 能力、提示版本、`readOnly`、namespace、本次启动的 control key（响应体 + `Set-Cookie`） |
| GET | `/plugins/dsh-memory-curate/browse?q=&tag=&limit=&includeExpired=1` | 上述 + control key | 搜索/列出记忆（UI 是本地管理员，跨 namespace 可见） |
| GET | `/plugins/dsh-memory-curate/trace?memoryId=<id>` | 同上 | 该记忆的 NDJSON 行（memory / audit / tombstone） |
| POST | `/plugins/dsh-memory-curate/update` | loopback + `Content-Type: application/json` + Origin/Sec-Fetch-Site + control key | 追加式取代（`service.updateMemory`） |
| POST | `/plugins/dsh-memory-curate/delete` | 同上 | 追加式墓碑（`service.deleteById`） |

成功响应：`status` → `{ok, enabled, promptVersion, key, capabilities{browse,trace,update,delete}}`；`browse` → `{ok, rows[], total, promptVersion}`；`trace` → `{ok, memoryId, rows[]}`；`update` → `{ok, id}`；`delete` → `{ok, tombstoneId}`。

失败统一 `{error}`：403（非 loopback / 跨站 Origin）、401（key 缺失或错误）、405（方法不对）、415（写请求没有 JSON content type）、400（请求体或参数非法）、413（请求体超过 64 KiB）、503（service 方法缺失或存储不可用）、500（其他）。

## 4. 鉴权

1. **loopback only**：同时检查 `Host` 头与 `req.socket.remoteAddress`（后者客户端无法伪造）。
2. **跨站防护**：Origin 必须与请求 scheme+Host 完全一致；`Sec-Fetch-Site` 存在时必须为 `same-origin` / `none`；写请求必须 `Content-Type: application/json`，且不对 OPTIONS 回 CORS 头。
3. **每次启动随机 control key**（24 字节 hex），通过 `/status` 的 HttpOnly cookie 与响应体交给页面；读写路由接受 cookie 或 `x-memory-curate-key` 头，比较前先 SHA-256 再 `timingSafeEqual`。
4. DSH 重启后旧 key 失效：面板收到 401 会重新取 `/status` 并重试一次。

## 5. 降级

- 没有 `webServer`：路由不挂载，面板显示“主机返回了非 JSON 响应（记忆路由可能没有注册）”，不影响其他设置项。
- `registerMemoryRoutes` 异常或路径重复：返回 `{ ok:false, error }` / 打 warning，`apply()` 继续注册四个工具。
- service 方法缺失：`/status.capabilities` 对应项为 false，面板禁用按钮；直接调用返回 503。
- 存储不可用：`/status.enabled === false`，面板显示横幅，编辑/删除禁用。
- 单写者锁被占用：`/status.readOnly === true`，面板显示只读横幅，编辑/删除禁用；浏览、回溯仍可用。
- 渲染异常：`PanelBoundary` 捕获并显示错误，不打断设置页。

## 6. 验证

```bash
node --check src/browser-routes.js
node --check src/ui/client.js
npm test   # 含 test/browser-routes.test.js：路由注册、鉴权、415/400/503、载荷
```

真实 UI 验收：同步到 profile → 重启 DSH → 刷新页面 → 设置 →「记忆」。仅刷新页面不会重新加载客户端 bundle。
