# P2 规格:LLM 自动解析规约生成点表(产品亮点,未来收费)

## 定位与决策(2026-07-16 用户确认)
- 首发 provider:**DeepSeek**(`https://api.deepseek.com`,OpenAI 兼容,model `deepseek-chat`);架构上做 OpenAI 兼容抽象,后续加 Kimi/Qwen/GLM 只是配置
- 解析路线:**本地抽文本 → LLM 只读文本**(不做多模态;扫描件不支持,明确提示)
- 商业化:V1 BYOK(用户自填 API Key,功能可用);V2 再做代理计费,本规格不含
- 差异化卖点:生成后可**接真设备实测校验**,自动标记/剔除不可读点位——竞品没有采集底座做不了

## 用户流程
```
类型/实例管理 → [AI 生成点表] 按钮
 1. 选文件(pdf/docx/doc/txt) → 本地抽文本,显示字数和预览头部
 2. (首次)设置:API Key、baseURL(默认 DeepSeek)、model —— 存 config.json llm 字段
 3. 点[开始解析] → 分段调用 LLM,进度条(第 n/N 段,累计点位数,累计 token)
 4. 结果预览:可编辑表格(复用类型编辑器组件),显示总点数/各区域分布
 5. (可选)[实测校验]:选一个空闲串口+连接参数 → 逐点扫描 → 不可读点位标红,一键剔除
 6. [保存为新类型] → 走现有 validatePoints + 落库
```

## 技术方案

### 文本抽取(本地,零 token)
- PDF:`pdf-parse`(npm);DOCX:`mammoth`;**旧版二进制 .doc:`word-extractor`(npm)**——今天实测 olefile 思路可行,word-extractor 是其 JS 等价物;TXT 直读
- 抽取失败/文本量 <200 字:提示"文档无法抽取文本(可能是扫描件),请转换为文字版"
- 全部在 **main 进程**做(Electron)/服务端做(Web 模式),renderer 只传文件

### LLM 调用(main/服务端,不在浏览器发——Key 不进前端、无 CORS)
- 新模块 `main/llm/provider.js`:OpenAI 兼容 chat.completions 封装,`{ baseURL, apiKey, model }` 注入,支持超时/重试(429/5xx 重试 2 次退避)
- 新模块 `main/llm/point-extractor.js`(纯逻辑,重点测试):
  - 分段:按 ~12K 字符切,段边界对齐"寄存器/地址行",段间重叠 500 字符防切断表行
  - 每段一次调用,**system prompt 固化今天的实战经验**:
    - 地址可能是 16 进制(如 `11C0`),要求 LLM 输出时标注 `addrHex` 原文,由代码统一转换,不让 LLM 算进制
    - `XXXX-XXXX` 地址区间 = 双字(uint32);`单位：0.001V` → k=0.001, unit=V, decimals=3
    - 区域词映射:保持寄存器→holding、输入寄存器→input、线圈→coil、离散量→discrete
    - 输出严格 JSON 数组(response_format json_object),字段对齐 `modbusmate-points@1`
  - 汇总:跨段去重(area+addr)、JSON 修复(截断容错)、`Codec.validatePoints` 终审
- 新运行时通道:`llm:extractPoints`(启动任务)+ 进度经现有事件桥推送(`llm:progress` 事件:段号/累计点数/token 用量);WEB_RUNTIME_CHANNELS、IPC、preload、web-api 四处同步注册(参照 rawRequest 的接法)
- token 用量:累加 API 返回的 usage,完成后显示"本次消耗约 N tokens(约 ¥X,按 DeepSeek 牌价)"

### 实测校验(差异化)
- 复用现有单点扫描思路(逐点读、25ms 间隔、800ms 超时)做成通道 `llm:verifyPoints`(或复用 device 体系临时实例)
- 结果:每点 ok / 异常码 N / 超时;预览表格标红不可读行,提供[剔除不可读]按钮
- 明确提示:"设备寄存器可能随工作模式增减,当前模式下不可读 ≠ 地址错误"(今天的教训写进 UI 文案)

### 配置与安全
- `config.json` 增加 `llm: { baseURL, apiKey, model }`;UI 里 Key 显示为掩码
- 明文存储风险在设置页注明"Key 保存在本机配置文件,请勿在共用电脑保存"
- 只上传文档文本给 LLM,不上传任何设备数据/点表现值

## 任务拆分
| 任务 | 内容 | 建议执行者 |
|---|---|---|
| P2-1 | 文本抽取模块 + 三种格式单测 | Codex |
| P2-2 | provider + point-extractor(纯逻辑重测试,mock API) | Codex |
| P2-3 | 通道/IPC/preload/web-api 四处接线 + 进度事件 | Codex |
| P2-4 | 前端向导 UI(4 步流程 + 设置页) | Trae |
| P2-5 | 实测校验闭环 | Codex |

## 验收
- 用今天的真实文档回归:`多功能双向直流电源使用说明书--五标合一.doc` 应产出 ≥120 个可校验通过的点位,地址与 `docs/点表-多功能双向直流电源.json` 抽查一致(尤其 0x4544→17732 这类 16 进制转换)
- API Key 错误/网络断/文档过大等异常路径都有明确中文提示
- `npx vitest run` 全绿;LLM 调用全部 mock,CI 不耗真实 token
