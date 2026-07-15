# 云快充充电枪实时监测点表 — ModbusMate 读取配置

> 依据：《充电桩与云快充服务平台交互协议 V1.5》7.2 上传实时监测数据（帧类型码 0x13）
> 日期：2026-07-15

## 1. 背景与假设

云快充协议是充电桩与云平台之间基于 TCP 的自定义帧协议（依据国网 104 规约），**不是 Modbus 协议**。
本配置将 0x13 帧的实时监测点表映射为 Modbus 保持寄存器，适用于以下场景之一：

- 现场有协议转换网关（云快充 → Modbus-TCP），按本映射表配置网关点位；
- 使用 ModbusMate 内置模拟器验证 UI 与采集链路。

映射约定：全部使用保持寄存器（holding），字序 AB（高字在前），协议地址从 0 起。

## 2. 寄存器映射表

| 协议地址 | PLC 地址 | 点位名称 | 类型 | 变换 | 单位 | 协议原文备注 |
|---|---|---|---|---|---|---|
| 0 | 40001 | 枪号 | uint16 | — | — | BCD 1 字节 |
| 1 | 40002 | 枪状态 | uint16 | — | — | 0 离线 / 1 故障 / 2 空闲 / 3 充电 |
| 2 | 40003 | 枪是否归位 | uint16 | — | — | 0 否 / 1 是 / 2 未知 |
| 3 | 40004 | 是否插枪 | uint16 | — | — | 0 否 / 1 是 |
| 4 | 40005 | 输出电压 | uint16 | ×0.1 | V | 精确到 0.1，待机置零 |
| 5 | 40006 | 输出电流 | uint16 | ×0.1 | A | 精确到 0.1，待机置零 |
| 6 | 40007 | 枪线温度 | uint16 | −50 | ℃ | 偏移量 −50，待机置零 |
| 7 | 40008 | SOC | uint16 | — | % | 待机/交流桩置零 |
| 8 | 40009 | 电池组最高温度 | uint16 | −50 | ℃ | 偏移量 −50，待机/交流桩置零 |
| 9 | 40010 | 累计充电时间 | uint16 | — | min | 待机置零 |
| 10 | 40011 | 剩余时间 | uint16 | — | min | 待机/交流桩置零 |
| 11–12 | 40012 | 充电度数 | uint32 | ×0.0001 | kWh | 精确到 4 位小数 |
| 13–14 | 40014 | 计损充电度数 | uint32 | ×0.0001 | kWh | 未设计损比例时等于充电度数 |
| 15–16 | 40016 | 已充金额 | uint32 | ×0.0001 | 元 | (电费+服务费)×计损充电度数 |
| 17 | 40018 | 硬件故障字 | hex | — | — | Bit1~Bit13 位表示，见 §4 |

共占用寄存器 0–17（18 个字），轮询时可一次连续读取。

**未纳入的字段**：交易流水号（BCD 16 字节）、桩编码（BCD 7 字节）、枪线编码（BIN 8 字节）——
均为标识类字段而非遥测量，ModbusMate 当前无字符串/BCD 类型，建议在设备实例名称中人工标注桩编码。

## 3. ModbusMate 设备类型配置（可直接并入 config.json 的 deviceTypes）

```json
{
  "id": "ykc_gun_realtime",
  "name": "云快充充电枪",
  "points": [
    { "name": "枪号",         "area": "holding", "addr": 0,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "" },
    { "name": "枪状态",       "area": "holding", "addr": 1,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "" },
    { "name": "枪是否归位",   "area": "holding", "addr": 2,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "" },
    { "name": "是否插枪",     "area": "holding", "addr": 3,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "" },
    { "name": "输出电压",     "area": "holding", "addr": 4,  "type": "uint16", "wordOrder": "AB", "k": 0.1,    "b": 0,   "decimals": 1, "unit": "V" },
    { "name": "输出电流",     "area": "holding", "addr": 5,  "type": "uint16", "wordOrder": "AB", "k": 0.1,    "b": 0,   "decimals": 1, "unit": "A" },
    { "name": "枪线温度",     "area": "holding", "addr": 6,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": -50, "decimals": 0, "unit": "℃" },
    { "name": "SOC",          "area": "holding", "addr": 7,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "%" },
    { "name": "电池组最高温度", "area": "holding", "addr": 8,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": -50, "decimals": 0, "unit": "℃" },
    { "name": "累计充电时间", "area": "holding", "addr": 9,  "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "min" },
    { "name": "剩余时间",     "area": "holding", "addr": 10, "type": "uint16", "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "min" },
    { "name": "充电度数",     "area": "holding", "addr": 11, "type": "uint32", "wordOrder": "AB", "k": 0.0001, "b": 0,   "decimals": 4, "unit": "kWh" },
    { "name": "计损充电度数", "area": "holding", "addr": 13, "type": "uint32", "wordOrder": "AB", "k": 0.0001, "b": 0,   "decimals": 4, "unit": "kWh" },
    { "name": "已充金额",     "area": "holding", "addr": 15, "type": "uint32", "wordOrder": "AB", "k": 0.0001, "b": 0,   "decimals": 4, "unit": "元" },
    { "name": "硬件故障字",   "area": "holding", "addr": 17, "type": "hex",    "wordOrder": "AB", "k": 1,      "b": 0,   "decimals": 0, "unit": "" }
  ]
}
```

设备实例示例（一桩两枪 = 两个实例，或同一实例内点表加偏移，推荐前者）：

```json
{ "id": "ykc_pile01_gun1", "typeId": "ykc_gun_realtime", "name": "55031412782305-1号枪", "host": "192.168.1.50", "port": 502, "unitId": 1, "interval": 15000 }
```

轮询周期建议对齐协议：充电中 15 s（协议规定充电 15 秒上送）、待机可放宽到 60 s+（协议待机 5 分钟）。
ModbusMate 当前为固定周期，建议按充电场景取 15000 ms。

## 4. 硬件故障字位定义（addr 17，hex 显示）

低位到高位（0 否 / 1 是）：

| Bit | 含义 | Bit | 含义 |
|---|---|---|---|
| 1 | 急停按钮动作故障 | 8 | 读卡器通信中断 |
| 2 | 无可用整流模块 | 9 | RC10 通信中断 |
| 3 | 出风口温度过高 | 10 | 风扇调速板故障 |
| 4 | 交流防雷故障 | 11 | 直流熔断器故障 |
| 5 | 交直流模块 DC20 通信中断 | 12 | 高压接触器故障 |
| 6 | 绝缘检测模块 FC08 通信中断 | 13 | 门打开 |
| 7 | 电度表通信中断 | | |

## 5. 枚举值速查

- **枪状态**（addr 1）：0x00 离线、0x01 故障、0x02 空闲、0x03 充电（协议要求变位上送）
- **枪是否归位**（addr 2）：0x00 否、0x01 是、0x02 未知（无法检测枪是否插回枪座）
- **是否插枪**（addr 3）：0x00 否、0x01 是
