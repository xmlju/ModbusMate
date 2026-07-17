# Trae 任务书 — P2-4 LLM 点表生成向导 UI（2026-07-17）

## 背景（必读）

P2-3 后端接线已完成并合入：`llm:extractText`（文档抽文本）、`llm:extractPoints`（LLM 分段抽点位）两个通道 + `llm:progress` 进度事件，Electron 与网页模式均可用。**本任务只做前端向导 UI，不改 `main/` 下任何文件。**

真实验证数据（可用于自测预期）：12.7MB 的《多功能双向直流电源使用说明书--五标合一.doc》上传抽取 → `charCount: 130757`，全流程无需 API Key；只有第 3 步"开始解析"才消耗 token。

**约定**：注释用中文；错误提示要详细；代码结构简洁；`npx vitest run` 全绿才算完成（当前基线 **663** 个测试全过）。

---

## 后端 API 契约（已实现，照此调用）

### 1. `window.api.llmExtractText(params)` — 抽取文档文本

**推荐统一用上传模式**（Electron 和网页行为一致，实现最简单）：

```js
// 用 <input type="file" accept=".pdf,.docx,.doc,.txt"> 拿到 File 后：
const buf = await file.arrayBuffer()
const dataBase64 = btoa(...)  // 注意大文件别用扩展运算符，分块转或用 FileReader.readAsDataURL 去头
const res = await window.api.llmExtractText({ fileName: file.name, dataBase64 })
// 成功: { ok:true, docId, fileName, charCount, preview, format }
// preview = 全文前 500 字符；docId 用于第 3 步
```

- 上传上限 20 MiB（解码后），超限/扫描件（<200字）/格式不支持都会 **reject 并带中文 message**，直接展示即可
- Electron 另有无参调用 `llmExtractText()` 会弹系统文件对话框（取消时 resolve `{ ok:false, canceled:true }`），可不用
- 网页模式该通道超时已放宽到 2 分钟

### 2. `window.api.llmExtractPoints({ docId })` — 启动 LLM 解析

```js
const result = await window.api.llmExtractPoints({ docId })
// 成功: { points: [...modbusmate-points@1 格式，已过 validatePoints...],
//         stats: { totalSegments, totalTokens, droppedInvalid, addrAmbiguityWarning } }
```

- **前置条件**：`config.json` 的 `llm` 字段已配置（见设置页），否则 reject：`尚未配置 LLM 服务，请先在设置中填写 API Key、baseURL 和模型`
- 同一时间只允许一个任务，重复点击会 reject：`已有一个 LLM 解析任务在进行中…`——按钮要做 disabled 防抖
- `addrAmbiguityWarning` 非 null 时是字符串提示（文档地址进制歧义），黄色警告条展示，不拦截
- 网页模式该通道超时已放宽到 10 分钟
- API Key 错误 / 网络断等会 reject 中文 message（如 `LLM API 错误 (401): …`），展示原文

### 3. `window.api.onLlmProgress(fn)` — 进度事件

```js
window.api.onLlmProgress(p => {
  // p = { docId, segment, totalSegments, accumulatedPoints, accumulatedTokens }
})
```

- **必须校验 `p.docId === 当前任务 docId`** 再更新进度条
- 网页模式返回退订函数，Electron 返回 undefined——注册一次全局复用即可，不要每次开向导重复注册

### 4. LLM 设置 — 存在现有 config 里

复用 `window.api.loadConfig()` / `saveConfig()`，字段：

```js
cfg.llm = { baseURL: 'https://api.deepseek.com', apiKey: 'sk-...', model: 'deepseek-chat' }
```

保存时务必 `{ ...cfg, llm }` 展开合并，别覆盖掉 deviceTypes 等其他字段。

---

## 任务列表

### T1. 向导入口 + 4 步流程（高）

入口：**类型/实例管理页**（`#mgrPage`）工具栏，「新建类型」旁加「AI 生成点表」按钮。弹出向导弹窗（风格与 `typeEditorModal` 一致），4 步：

1. **选文件**：file input（accept `.pdf,.docx,.doc,.txt`）→ 调 `llmExtractText` → 显示文件名、字数、预览头部（前 500 字，等宽字体滚动区）。抽取中显示 loading（大 .doc 上传+解析要几秒）
2. **检查 LLM 设置**：未配置时内嵌设置表单（见 T2）；已配置显示"模型：deepseek-chat ✓"一行 + [修改] 链接
3. **开始解析**：调 `llmExtractPoints`，进度条显示 `第 n/N 段 · 已抽取 m 个点位 · 累计 x tokens`；完成后显示 `本次消耗约 N tokens（约 ¥X.XX）`——单价常量放显眼位置便于调整，粗估 `¥4 / 百万 tokens`
4. **结果预览与保存**：
   - 汇总行：总点数 + 各区域分布（如 `holding 96 · input 24 · coil 8`）
   - `addrAmbiguityWarning` 非空时黄色警告条
   - `droppedInvalid > 0` 时提示"已自动剔除 N 条无效行"
   - 点位表格**复用类型编辑器的点位行组件**（`renderer/device.js` 类型点位编辑表格一带，含 16 进制地址显示逻辑），可编辑可删行
   - [保存为新类型]：走现有 `validatePoints` → 类型落库同一路径（参考 `device.js` 保存回调），类型名默认取文件名去扩展名
   - 预留灰色禁用按钮 [实测校验（即将上线）]——P2-5 再接

每步可后退；关闭弹窗要确认（第 3 步进行中关闭要二次确认，提示"解析仍在后台进行，token 照常消耗"）。

### T2. LLM 设置表单（高）

- 字段：baseURL（默认 `https://api.deepseek.com`）、API Key、model（默认 `deepseek-chat`）
- Key 显示为 password 输入框（掩码），已保存时显示 `sk-***...尾4位`
- 表单下方固定注明：**"Key 明文保存在本机配置文件，请勿在共用电脑上保存"**
- 保存即写 `cfg.llm`，向导内外共用（后续设置页复用同一段逻辑）

### T3. 大文件 base64 转换（高，易错点）

12.7MB 文件 `String.fromCharCode(...new Uint8Array(buf))` 会栈溢出。用分块循环或 `FileReader.readAsDataURL(file)` 然后去掉 `data:...;base64,` 前缀。前端先按 20 MiB 拦一道，提示与后端一致。

### T4. 测试（高）

- 可测的纯逻辑抽出独立函数/文件（参考 `renderer/device-config.js` 的模式）：区域分布统计、token 费用估算、base64 分块转换、类型名默认值生成，各写单测
- 向导流程状态机（当前步、能否前进/后退、进行中锁）如果抽成纯函数也补测
- 基线 663 全绿不许破坏

---

## 验收

1. 网页模式（`npm run web`）：上传真实 `多功能双向直流电源使用说明书--五标合一.doc` → 字数 130757 → 配 DeepSeek Key 后解析产出 ≥120 个点位 → 保存为新类型后出现在类型列表，16 进制地址转换正确（0x4544→17732 抽查）
2. 未配 Key 直接点解析：明确中文引导去设置，不是裸报错
3. 解析中途断网/Key 错误：错误原文展示，向导可回到第 3 步重试（docId 仍有效，不用重新上传）
4. `npx vitest run` 全绿
