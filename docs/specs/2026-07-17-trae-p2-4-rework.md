# Trae 返工单 — P2-4 LLM 向导 UI（2026-07-17，第 2 轮）

## 验收结论

上一轮交付**未通过**。原任务书（`2026-07-17-trae-p2-4-llm-wizard-ui.md`）的核心交付物是**可操作的向导 UI**，本轮只收到两个纯函数模块和 61 个测试（约等于 T4 的一半），T1/T2/T3 全部缺失：

- `renderer/` 下没有任何改动：没有「AI 生成点表」按钮、没有向导弹窗、没有设置表单、没有文件上传
- 用户打开应用后，**这个功能完全不存在**

**本轮完成的硬标准**：`npm run web` 打开页面，能从「类型/实例管理」页点按钮走完 选文件→设置→解析→保存为新类型 全流程。`git status` 里必须出现 `renderer/index.html`、`renderer/style.css` 和向导 JS 的改动——如果没有，说明 UI 还是没做，不要报完成。

## 返工项（先修，再做 UI）

### R1. 文件放错目录（违反任务书约束）

任务书明确"只做前端 UI，不改 `main/` 下任何文件"。迁移：

- `main/llm/utils.js` → `renderer/llm-utils.js`
- `main/llm/wizard-state.js` → `renderer/llm-wizard-state.js`
- 两个测试文件同步改 require 路径；模块导出方式参考 `renderer/codec.js`（浏览器 + Node 双兼容的 UMD 写法），因为浏览器端要用 `<script>` 直接加载

### R2. 状态机改回 4 步

任务书 T1 是 **4 步**向导：1 选文件 → 2 检查设置 → 3 解析 → 4 预览保存。你做了 6 步，把"实测校验"做进去了——那是 P2-5，后端通道还不存在。删掉多余步骤，第 4 步只留一个**灰色禁用**的 [实测校验（即将上线）] 按钮。

### R3. `estimateCost` 与后端契约脱节

你的签名要 `promptTokens/completionTokens` 分项，但后端 `llmExtractPoints` 返回的 `stats` **只有 `totalTokens`**（去读 `main/llm/point-extractor.js` 确认，不要凭想象定接口）。改为：

```js
estimateCost(totalTokens, pricePerMTokenCNY = 4)  // 粗估 ¥4/百万 tokens，常量可调
// 返回 { totalCost }，保留两位小数
```

对应测试同步改。

## 主体交付（原任务书 T1/T2/T3 原文有效，此处只列要点）

1. **T1 入口+弹窗**：`#mgrPage` 工具栏「新建类型」旁加「AI 生成点表」按钮；弹窗风格对齐 `typeEditorModal`；4 步可后退；第 3 步进行中关闭需二次确认
2. **T2 设置表单**：baseURL/API Key/model，Key 掩码显示，保存写 `cfg.llm`（`{ ...cfg, llm }` 合并，别覆盖 deviceTypes！），注明"Key 明文保存在本机配置文件，请勿在共用电脑上保存"
3. **T3 上传**：file input → 分块 base64（用你自己的 `chunkBase64` 拼整串，或 `FileReader.readAsDataURL` 去前缀）→ `window.api.llmExtractText({ fileName, dataBase64 })`；前端先拦 20 MiB
4. **进度**：`window.api.onLlmProgress(p)`，校验 `p.docId` 匹配再更新；按钮 disabled 防重复提交
5. **第 4 步预览**：总点数 + `areaStats` 分布；`addrAmbiguityWarning` 黄条；`droppedInvalid>0` 提示；点位表复用类型编辑器行组件；[保存为新类型] 走现有 `validatePoints` → 类型落库，默认名用你的 `generateDefaultTypeName`（传文件名去扩展名）

## 验收（不变，重申）

1. 网页模式上传真实 `多功能双向直流电源使用说明书--五标合一.doc` → 显示字数 130757 → 配 Key 解析 ≥120 点位 → 保存后出现在类型列表（0x4544→17732 抽查）
2. 未配 Key 点解析：中文引导去设置，不是裸报错
3. Key 错误/断网：错误原文展示，可回第 3 步重试（docId 仍有效）
4. `npx vitest run` 全绿（当前基线 **724**，R1/R3 迁移修改后不许掉）
