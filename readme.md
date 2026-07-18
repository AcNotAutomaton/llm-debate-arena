# LLM 辩论竞技场

一个让多个 AI 大模型**轮流发言、链式辩论**的交互平台。模型们基于对方的前序回答逐轮深入讨论，最后由裁判模型打分决出胜负。

---

## 功能特点

- **链式辩论**：模型依次发言，后一个模型基于前一个的回答继续分析，形成深度对话链条
- **多 Provider 混用**：同时支持本地 vLLM 服务和 DeepSeek 云端 API，两种来源的模型可以同台辩论
- **流式输出**：模型思考过程和回答实时推送到页面，无需等待
- **自动记录**：每场辩论结束后自动在 `debates/` 目录生成 Markdown 文件，文件名精确到秒
- **主题切换**：支持深色/浅色主题，右上角 🌙/☀️ 一键切换

## 快速开始

### 安装依赖

```bash
cd llm-arena
npm install
```

### 启动服务

```bash
node server.js
```

默认地址：http://localhost:3456

### 配置模型

打开页面后，点击右上角 ⚙️ 打开设置面板：

1. **DeepSeek 模型**（推荐）：
   - 在「DeepSeek API 密钥」输入框粘贴你的 API Key
   - 点击「测试 DeepSeek 连接」
   - 在模型列表中勾选你要用的模型（如 `deepseek-v4-pro`、`deepseek-v4-flash`）

2. **本地 vLLM 模型**（可选）：
   - 在「vLLM 服务地址」输入你的 vLLM 地址（默认 http://localhost:8000/v1）
   - 点击「测试连接」
   - 勾选本地模型

### 开始辩论

1. 在输入框中输入你想要讨论的问题
2. 点击「开始辩论」
3. 实时观看每个模型依次发言
4. 辩论结束后查看裁判评分

辩论记录会自动保存到 `debates/` 文件夹，文件名格式为 `YYYY-MM-DD_HH-mm-ss.md`。

## 技术架构

- **后端**：Node.js + Express，使用 SSE（Server-Sent Events）实时推送
- **前端**：原生 JavaScript + CSS Variables 主题系统
- **API**：支持 OpenAI 兼容格式（vLLM）和 DeepSeek API
- **记录**：Node.js fs 模块写入 Markdown 文件

## 项目结构

```
llm-arena/
  server.js          # 后端服务
  package.json       # 依赖配置
  node_modules/      # 依赖包
  debates/           # 辩论记录（自动生成）
  public/
    index.html       # 主页面
    app.js           # 前端逻辑
    style.css        # 样式（支持深色/浅色主题）
```

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API 密钥（可选，也可以在页面设置中填写）
- `PORT`：服务端口（默认 3456）

## License

MIT
