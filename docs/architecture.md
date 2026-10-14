# 项目职责与修改入口

## 启动与部署

继续使用 `npm start`，由一个 Express 服务同时托管静态页面和 `/api` 接口。
没有新增框架、构建工具、数据库或部署进程。前端使用浏览器原生 ES 模块，通过服务访问。

`src/server.js` 负责监听端口及启动时更新排名汇总。
`src/app.cjs` 的 `createApp()` 只创建应用，不监听端口；每次调用创建独立的内存状态。
测试可以传入临时 `projectRoot`，避免读取和写入真实记录目录。

## 后端

| 目录 / 文件 | 职责 | 不负责 |
| --- | --- | --- |
| `config.cjs` | 默认上游地址、项目根路径 | 实验状态 |
| `routes/` | 入参检查、状态码、响应、SSE 订阅 | 提示词、排名算法、文件读写 |
| `providers/catalog.cjs` | 模型列表与单模型可用性检测 | HTTP 路由 |
| `providers/model-client.cjs` | 提供方选择、调用、共享重试预算 | 排名与文件保存 |
| `providers/http.cjs` | JSON 响应检查、握手超时 | 实验调度 |
| `providers/stream-reader.cjs` | 三种协议流解析、内容清理、结束与截断检测 | 重试次数决策 |
| `providers/token-budget.cjs` | 推理模型识别、最低输出预算 | 页面配置 |
| `runtime/state.cjs` | 创建会话、订阅者、实验及临时聊天容器 | 文件持久化 |
| `runtime/events.cjs` | 事件推送、离线缓冲、实时进度与聊天更新 | 模型请求 |
| `services/debate.cjs` | 一场辩论的回答、互评、裁判与结束流程 | 路由 |
| `services/evaluation.cjs` | 互评提示、有效投票、补投、裁判 | 排名阶段调度 |
| `services/experiment.cjs` | 重复场次、回答顺序、阶段淘汰、并列加赛 | 流协议解析 |
| `services/prompts.cjs` | 单场调试提示词 | 网络调用 |
| `protocols/` | 实验回答规则和提供方请求协议 | 运行状态 |
| `storage/records.cjs` | JSON / Markdown 保存、历史记录读取与摘要 | 运行实验 |
| `reports/` | 完整排名汇总文件 | 单场实时聊天 |

应用装配顺序：运行状态、事件分发、模型调用、存储、互评、单场执行、排名调度、路由。
服务通过参数接收依赖；模型调用只接收事件回调，不直接读取实验或会话容器。
原始正文和显示流分别更新临时聊天与 SSE，避免重复累计正文。

临时聊天仍只存于 WeakMap，不写入实验 JSON 或 Markdown。
排名场次结束后仍清理对应会话与订阅集合。历史目录和记录字段保持兼容。

## 前端

`public/app.js` 是唯一脚本入口，负责初始化模块及连接回调。
其他文件用 `import` / `export` 明确依赖，不通过 `window` 暴露页面功能。

| 模块 | 职责 |
| --- | --- |
| `core/state.js` | 共享配置、当前运行状态及模型配色 |
| `core/dom.js` | DOM 引用、查询和 HTML 转义 |
| `core/api.js` | JSON 请求、实验详情读取、单场 SSE 连接 |
| `core/format.js` | 实验方式显示名称 |
| `features/settings.js` | 连接模型、批量检测、选择模型、保存设置和运行锁定 |
| `features/debug.js` | 单场提交、流事件显示、单场结果 |
| `features/experiment.js` | 实验提交、恢复、轮询、实时内容和结果 |
| `records.js` | 历史记录搜索、筛选、详情、下载与请求竞态处理 |
| `answer-order.js` | 顺序编辑和位置得票统计 |
| `workspace.js` | 页面布局、导航、新实验入口 |
| `ui/theme.js` | 深浅主题及主题偏好 |

设置变更通过入口提供的回调更新实验估算；调序和执行状态变更通过回调更新配置摘要。
模块之间不相互导入初始化函数，避免循环依赖。

## 常见修改

- 新增模型提供方：从 `providers/` 和 `protocols/provider-protocol.cjs` 开始，再修改模型连接界面和接口测试。
- 调整回答规则：修改 `protocols/experiment-protocol.cjs`，补协议测试。
- 调整排名与加赛：修改 `services/experiment.cjs`，运行实验端到端测试。
- 修改错误处理：检查 `providers/http.cjs`、`model-client.cjs`、`stream-reader.cjs` 及相应执行服务，运行重试和互评保护测试。
- 调整记录字段：同时检查 `storage/records.cjs`、`records.js`、统计脚本及旧记录兼容测试。
- 修改页面交互：修改对应前端功能模块，运行回答顺序和实验记录浏览器测试。

本次仅拆分职责，没有增加数据库、分页、任务队列或独立部署。记录列表全量读取和实验详情轮询仍沿用原方案，后续可根据数据量单独优化。
