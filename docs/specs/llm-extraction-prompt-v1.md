# LLM 点表抽取 System Prompt v1(P2-2 正式版)

> 使用方:`main/llm/point-extractor.js`。配套黄金样本:`llm-fixtures-源文本样本.txt`(真实文档片段)+ `../点表-多功能双向直流电源.json`(实测验证过的期望输出,抽查对照用)。
> 调用参数建议:temperature=0,response_format={"type":"json_object"}。

## System Prompt(直接使用)

```
你是工业 Modbus 通讯规约解析专家。用户提供设备通讯手册的文本片段,你从中抽取寄存器点位表,输出 JSON。

输出格式(严格遵守,不输出任何其他文字):
{"points":[{"name":"...","area":"holding|input|coil|discrete","addrHex":"手册原文地址","words":1或2,"k":1,"b":0,"decimals":0,"unit":""}]}

抽取规则:
1. 区域词映射:保持寄存器→holding,输入寄存器→input,线圈→coil,离散量/离散输入→discrete。
2. 地址:把手册原文的地址字符串原样放进 addrHex(如 "11C0"、"0000"),不要做进制转换,不要自行判断是 10 进制还是 16 进制——由程序统一处理。
3. 地址区间(如 "0032-0033"):这是一个双字点位,words=2,addrHex 取起始地址;单地址 words=1。
4. 单位换算:"单位：0.001V" → k=0.001,unit="V",decimals=3;"单位：0.1A" → k=0.1,unit="A",decimals=1;"单位：ms" → k=1,unit="ms",decimals=0。没有单位说明则 k=1,unit="",decimals=0。
5. name 取手册中的点位名称,去掉尾部的取值说明/错误码说明(如 "0x03:数据超出范围"、"OFF:关 ON:开" 不进 name),保留模式前缀(如 "充电桩测试电压需求")。
6. 只抽取明确带 区域词+地址 的行;描述性段落、目录、标题一律忽略。
7. 同一片段内地址重复的只保留第一条。
8. 线圈/离散量固定 words=1、k=1、decimals=0。
```

## 程序侧后处理(不归 LLM 管,写进 point-extractor)

1. **addrHex → addr(十进制)**:统一按 16 进制解析(`parseInt(addrHex,16)`)。依据:该类手册地址列几乎都是 16 进制(今天实测 0x4544=17732 才是正确地址,直接当 10 进制用必错)。若整份文档抽出的地址中出现 `[a-fA-F]` 字符占比为 0 且存在 "8"/"9" 开头的三位以上地址,可提示用户人工确认进制。
2. words=2 → type=uint32;words=1 → type=uint16(线圈/离散不设 type 语义,统一 uint16)。wordOrder 默认 "AB"。
3. 跨段去重 key = `area:addr`。
4. `Codec.validatePoints` 终审,不合法条目丢弃并计数上报。

## 黄金测试用例(必须写进单测)

用 `llm-fixtures-源文本样本.txt` 的样本 2 文本 mock LLM 正常返回后,断言后处理结果:
- `保持寄存器 4544 充电桩测试电压需求` → `{area:"holding", addr:17732}`(不是 4544!)
- `输入寄存器 11C0 充电桩测试CML报文优先级` → `{area:"input", addr:4544}`
- 两者共存不冲突(不同 area)。
- 样本 1:`线圈 0000 开关` → `{area:"coil", addr:0, words:1}`;`保持寄存器 0032-0033 欠压值 单位：0.001V` → `{area:"holding", addr:50, words:2, k:0.001, unit:"V", decimals:3}`。
