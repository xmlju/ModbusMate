# ModbusMate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ModbusMate——Electron 桌面版 Modbus-TCP 调试工具（轮询监控 + 单点写入 + 数据类型解析 + 激活授权），Win + Mac。

**Architecture:** 主进程（Node）承载 Modbus 通信（modbus-serial）、轮询调度、激活验证；渲染进程纯展示，经 contextBridge 白名单 IPC 通信。数据解析（codec）是渲染层纯函数，主进程只传原始寄存器值。

**Tech Stack:** Electron、modbus-serial、Vitest、electron-builder。全部中文注释。

**规格文档:** `docs/specs/2026-07-03-modbusmate-design.md`

**对规格的一处补充:** 32 位类型（Int32/UInt32/Float32）写入需一次写 2 个寄存器，使用 FC16（writeRegisters）；16 位类型仍用 FC06，线圈用 FC05。用户视角仍是"单点写入"（写一行的一个值）。

**约定:**
- 项目根目录：`/Users/yaominghua/Documents/project/ModbusMate`，所有命令在根目录执行
- 主进程/测试基础设施为 CommonJS；`renderer/codec.js` 用"全局常量 + module.exports 兜底"写法，浏览器和 Vitest 都能加载
- 每个任务以 git commit 结束

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `main/index.js`（最小可运行版，后续任务扩充）
- Create: `renderer/index.html`（占位版）
- Create: `preload.js`（空桥接，后续任务扩充）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "modbusmate",
  "version": "0.1.0",
  "description": "ModbusMate — Modbus-TCP 调试工具",
  "main": "main/index.js",
  "scripts": {
    "start": "electron .",
    "dev": "MM_DEV=1 electron .",
    "test": "vitest run",
    "sim": "node test/simulator.js",
    "dist": "electron-builder"
  },
  "dependencies": {
    "modbus-serial": "^8.0.17"
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-builder": "^25.1.8",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
（若 Electron 下载慢，用国内镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`）
Expected: 无 error 退出

- [ ] **Step 3: 最小主进程与页面**

`main/index.js`:

```js
// main/index.js — 主进程入口（Task 10 会扩充 IPC 与服务接线）
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 940, height: 680, minWidth: 800, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
```

`preload.js`:

```js
// preload.js — IPC 白名单桥接（Task 10 会填充 API）
const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('api', {})
```

`renderer/index.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>ModbusMate</title></head>
<body><h1>ModbusMate 脚手架</h1></body>
</html>
```

- [ ] **Step 4: 验证窗口能启动**

Run: `npm start`
Expected: 弹出窗口显示"ModbusMate 脚手架"，手动关闭窗口退出

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json main/index.js preload.js renderer/index.html
git commit -m "chore: Electron 项目脚手架"
```

---

### Task 2: codec — 16 位类型与 Hex 编解码（TDD）

**Files:**
- Create: `renderer/codec.js`
- Test: `test/codec.test.js`

- [ ] **Step 1: 写失败测试**

`test/codec.test.js`:

```js
import { describe, it, expect } from 'vitest'
import Codec from '../renderer/codec.js'

const { decode, encode, TYPES } = Codec

describe('16 位类型解码', () => {
  it('UInt16 原样返回', () => {
    expect(decode([250], 0, 'uint16')).toBe(250)
    expect(decode([0xFFFF], 0, 'uint16')).toBe(65535)
  })
  it('Int16 负数补码转换', () => {
    expect(decode([0xFFFB], 0, 'int16')).toBe(-5)
    expect(decode([0x7FFF], 0, 'int16')).toBe(32767)
  })
  it('Hex 显示为 4 位大写十六进制', () => {
    expect(decode([0x00FA], 0, 'hex')).toBe('0x00FA')
  })
  it('越界 offset 返回 null', () => {
    expect(decode([1], 5, 'uint16')).toBe(null)
  })
})

describe('16 位类型编码', () => {
  it('UInt16 编码为单字', () => {
    expect(encode('250', 'uint16')).toEqual([250])
  })
  it('Int16 负数编码为补码', () => {
    expect(encode('-5', 'int16')).toEqual([0xFFFB])
  })
  it('Hex 解析（带/不带 0x 前缀）', () => {
    expect(encode('1A2B', 'hex')).toEqual([0x1A2B])
    expect(encode('0x1A2B', 'hex')).toEqual([0x1A2B])
  })
  it('超范围抛出带范围说明的错误', () => {
    expect(() => encode('70000', 'uint16')).toThrow('0 ~ 65535')
    expect(() => encode('-40000', 'int16')).toThrow('-32768 ~ 32767')
    expect(() => encode('XYZ9', 'hex')).toThrow('十六进制')
  })
})

describe('TYPES 元数据', () => {
  it('含全部 6 种类型及字数', () => {
    expect(TYPES.int16.words).toBe(1)
    expect(TYPES.float32.words).toBe(2)
    expect(Object.keys(TYPES)).toEqual(['int16', 'uint16', 'int32', 'uint32', 'float32', 'hex'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/codec.test.js`
Expected: FAIL（codec.js 不存在）

- [ ] **Step 3: 实现 codec.js（16 位部分，32 位 case 留空抛错）**

`renderer/codec.js`:

```js
// renderer/codec.js — 数据类型编解码与地址换算（纯函数，无依赖）
// 浏览器：<script> 引入后使用全局 Codec；Vitest：module.exports 加载
const Codec = (() => {

  const TYPES = {
    int16:   { label: 'Int16',   words: 1 },
    uint16:  { label: 'UInt16',  words: 1 },
    int32:   { label: 'Int32',   words: 2 },
    uint32:  { label: 'UInt32',  words: 2 },
    float32: { label: 'Float32', words: 2 },
    hex:     { label: 'Hex',     words: 1 },
  }

  // registers: 16 位原始值数组；offset: 行下标；wordOrder: 'AB' 高字在前 / 'BA' 低字在前
  function decode(registers, offset, type, wordOrder = 'AB') {
    const w0 = registers[offset]
    if (w0 === undefined) return null
    switch (type) {
      case 'uint16': return w0
      case 'int16':  return w0 > 0x7FFF ? w0 - 0x10000 : w0
      case 'hex':    return '0x' + w0.toString(16).toUpperCase().padStart(4, '0')
      default: throw new Error(`未知数据类型: ${type}`)
    }
  }

  // 返回待写入的 16 位字数组（长度 1 或 2）
  function encode(value, type, wordOrder = 'AB') {
    switch (type) {
      case 'uint16': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0 || n > 0xFFFF) throw new Error('UInt16 取值范围 0 ~ 65535')
        return [n]
      }
      case 'int16': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < -0x8000 || n > 0x7FFF) throw new Error('Int16 取值范围 -32768 ~ 32767')
        return [n < 0 ? n + 0x10000 : n]
      }
      case 'hex': {
        const s = String(value).trim().replace(/^0x/i, '')
        if (!/^[0-9a-fA-F]{1,4}$/.test(s)) throw new Error('Hex 格式应为 1~4 位十六进制，如 1A2B')
        return [parseInt(s, 16)]
      }
      default: throw new Error(`未知数据类型: ${type}`)
    }
  }

  return { TYPES, decode, encode }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = Codec
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/codec.test.js`
Expected: PASS（全部用例绿）

- [ ] **Step 5: Commit**

```bash
git add renderer/codec.js test/codec.test.js
git commit -m "feat: codec 16位类型与Hex编解码（TDD）"
```

---

### Task 3: codec — 32 位类型与字序（TDD）

**Files:**
- Modify: `renderer/codec.js`
- Test: `test/codec.test.js`（追加）

- [ ] **Step 1: 追加失败测试**

在 `test/codec.test.js` 末尾追加：

```js
describe('32 位类型解码（字序）', () => {
  // 25.6 的 IEEE754 = 0x41CCCCCD
  it('Float32 AB 字序（高字在前）', () => {
    expect(decode([0x41CC, 0xCCCD], 0, 'float32', 'AB')).toBeCloseTo(25.6, 5)
  })
  it('Float32 BA 字序（低字在前）', () => {
    expect(decode([0xCCCD, 0x41CC], 0, 'float32', 'BA')).toBeCloseTo(25.6, 5)
  })
  it('Int32 负数', () => {
    expect(decode([0xFFFF, 0xFFFF], 0, 'int32', 'AB')).toBe(-1)
  })
  it('UInt32', () => {
    expect(decode([0x1234, 0x5678], 0, 'uint32', 'AB')).toBe(0x12345678)
  })
  it('缺少第二个寄存器返回 null', () => {
    expect(decode([0x41CC], 0, 'float32', 'AB')).toBe(null)
  })
})

describe('32 位类型编码（字序）', () => {
  it('Float32 AB 编码为两个字', () => {
    expect(encode('25.6', 'float32', 'AB')).toEqual([0x41CC, 0xCCCD])
  })
  it('Float32 BA 字序反转', () => {
    expect(encode('25.6', 'float32', 'BA')).toEqual([0xCCCD, 0x41CC])
  })
  it('Int32 负数编码', () => {
    expect(encode('-1', 'int32', 'AB')).toEqual([0xFFFF, 0xFFFF])
  })
  it('UInt32 超范围抛错', () => {
    expect(() => encode('4294967296', 'uint32')).toThrow('0 ~ 4294967295')
  })
  it('非数字输入抛错', () => {
    expect(() => encode('abc', 'float32')).toThrow('请输入数字')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/codec.test.js`
Expected: 新增用例 FAIL（"未知数据类型"）

- [ ] **Step 3: 实现 32 位分支**

在 `renderer/codec.js` 的 IIFE 内、`TYPES` 定义之后加入辅助函数：

```js
  // 两个 16 位字合成 32 位无符号整数
  function toU32(w0, w1, wordOrder) {
    const [hi, lo] = wordOrder === 'BA' ? [w1, w0] : [w0, w1]
    return hi * 0x10000 + lo
  }
```

`decode` 的 switch 中，`default` 之前加入：

```js
      case 'uint32':
      case 'int32':
      case 'float32': {
        const w1 = registers[offset + 1]
        if (w1 === undefined) return null
        const u32 = toU32(w0, w1, wordOrder)
        if (type === 'uint32') return u32
        if (type === 'int32') return u32 > 0x7FFFFFFF ? u32 - 0x100000000 : u32
        const buf = new DataView(new ArrayBuffer(4))
        buf.setUint32(0, u32)
        return buf.getFloat32(0)
      }
```

`encode` 的 switch 中，`default` 之前加入：

```js
      case 'uint32':
      case 'int32':
      case 'float32': {
        const n = Number(value)
        if (Number.isNaN(n)) throw new Error('请输入数字')
        const buf = new DataView(new ArrayBuffer(4))
        if (type === 'float32') {
          buf.setFloat32(0, n)
        } else {
          if (!Number.isInteger(n)) throw new Error('请输入整数')
          if (type === 'uint32' && (n < 0 || n > 0xFFFFFFFF)) throw new Error('UInt32 取值范围 0 ~ 4294967295')
          if (type === 'int32' && (n < -0x80000000 || n > 0x7FFFFFFF)) throw new Error('Int32 取值范围 -2147483648 ~ 2147483647')
          buf.setUint32(0, n < 0 ? n + 0x100000000 : n)
        }
        const hi = buf.getUint16(0), lo = buf.getUint16(2)
        return wordOrder === 'BA' ? [lo, hi] : [hi, lo]
      }
```

- [ ] **Step 4: 运行确认全部通过**

Run: `npx vitest run test/codec.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/codec.js test/codec.test.js
git commit -m "feat: codec 32位类型与AB/BA字序（TDD）"
```

---

### Task 4: codec — PLC/协议地址换算（TDD）

**Files:**
- Modify: `renderer/codec.js`
- Test: `test/codec.test.js`（追加）

- [ ] **Step 1: 追加失败测试**

在 `test/codec.test.js` 末尾追加（注意顶部解构需补充：把 `const { decode, encode, TYPES } = Codec` 改为 `const { decode, encode, TYPES, toPlcAddress, toProtocolAddress } = Codec`）：

```js
describe('PLC/协议地址换算', () => {
  it('协议地址 → PLC 习惯地址', () => {
    expect(toPlcAddress(0, 'coil')).toBe(1)
    expect(toPlcAddress(0, 'discrete')).toBe(10001)
    expect(toPlcAddress(9, 'input')).toBe(30010)
    expect(toPlcAddress(0, 'holding')).toBe(40001)
    expect(toPlcAddress(99, 'holding')).toBe(40100)
  })
  it('PLC 地址 → 协议地址', () => {
    expect(toProtocolAddress(40001, 'holding')).toBe(0)
    expect(toProtocolAddress(30010, 'input')).toBe(9)
  })
  it('PLC 地址低于区域基址抛错', () => {
    expect(() => toProtocolAddress(39999, 'holding')).toThrow('超出')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/codec.test.js`
Expected: 新增用例 FAIL

- [ ] **Step 3: 实现地址换算**

`renderer/codec.js` IIFE 内加入（并把 `return { TYPES, decode, encode }` 改为 `return { TYPES, decode, encode, toPlcAddress, toProtocolAddress }`）：

```js
  // PLC 习惯地址基址：线圈 0xxxx（从 1 计）、离散输入 1xxxx、输入寄存器 3xxxx、保持寄存器 4xxxx
  const PLC_BASE = { coil: 1, discrete: 10001, input: 30001, holding: 40001 }

  function toPlcAddress(protocolAddr, area) {
    return PLC_BASE[area] + protocolAddr
  }

  function toProtocolAddress(plcAddr, area) {
    const p = plcAddr - PLC_BASE[area]
    if (p < 0 || p > 65535) throw new Error(`地址超出${area === 'holding' ? '保持寄存器' : area === 'input' ? '输入寄存器' : area === 'coil' ? '线圈' : '离散输入'}区域范围`)
    return p
  }
```

- [ ] **Step 4: 运行确认全部通过**

Run: `npx vitest run test/codec.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/codec.js test/codec.test.js
git commit -m "feat: codec PLC/协议地址换算（TDD）"
```

---

### Task 5: Modbus-TCP 从站模拟器

**Files:**
- Create: `test/simulator.js`

- [ ] **Step 1: 实现模拟器**

`test/simulator.js`:

```js
// test/simulator.js — Modbus-TCP 从站模拟器
// 独立运行：node test/simulator.js [端口]（默认 8502，从站ID 1）
// 集成测试：const { createSimulator } = require('./simulator')
const ModbusRTU = require('modbus-serial')

function createSimulator(port = 8502) {
  const holding = new Uint16Array(200)
  const coils = new Uint8Array(200)

  // 预置数据：40001=250；40003/40004 = Float32(AB) 25.6
  holding[0] = 250
  const f = new DataView(new ArrayBuffer(4))
  f.setFloat32(0, 25.6)
  holding[2] = f.getUint16(0)
  holding[3] = f.getUint16(2)

  // 地址 10 每秒自增，模拟变化的传感器值（供界面观察高亮）
  const timer = setInterval(() => { holding[10] = (holding[10] + 1) & 0xFFFF }, 1000)

  const vector = {
    getHoldingRegister: addr => holding[addr],
    getInputRegister:   addr => 1000 + addr,
    getCoil:            addr => coils[addr] === 1,
    getDiscreteInput:   addr => addr % 2 === 0,
    setRegister: (addr, value) => { holding[addr] = value },
    setCoil:     (addr, value) => { coils[addr] = value ? 1 : 0 },
  }

  const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, unitID: 1 })
  return {
    server, holding, coils,
    close: () => { clearInterval(timer); return new Promise(r => server.close(r)) },
  }
}

module.exports = { createSimulator }

if (require.main === module) {
  const port = Number(process.argv[2]) || 8502
  createSimulator(port)
  console.log(`Modbus-TCP 模拟从站已启动: 127.0.0.1:${port}（从站ID 1）`)
  console.log('预置: 40001=250, 40003/40004=Float32(AB) 25.6, 40011 每秒自增')
}
```

- [ ] **Step 2: 手动验证能启动**

Run: `node test/simulator.js 8502 & sleep 2 && kill %1`
Expected: 打印"模拟从站已启动"

- [ ] **Step 3: Commit**

```bash
git add test/simulator.js
git commit -m "feat: Modbus-TCP 从站模拟器"
```

---

### Task 6: modbus-service —— 连接与读写（对模拟器集成测试）

**Files:**
- Create: `main/modbus-service.js`
- Test: `test/modbus-service.test.js`

- [ ] **Step 1: 写失败测试**

`test/modbus-service.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import ModbusService from '../main/modbus-service.js'
import { createSimulator } from './simulator.js'

let sim, svc

beforeAll(async () => {
  sim = createSimulator(8502)
  svc = new ModbusService()
  await svc.connect({ host: '127.0.0.1', port: 8502, unitId: 1 })
})

afterAll(async () => {
  await svc.disconnect()
  await sim.close()
})

describe('ModbusService 读', () => {
  it('FC03 读保持寄存器', async () => {
    const v = await svc.read('holding', 0, 2)
    expect(v[0]).toBe(250)
  })
  it('FC04 读输入寄存器', async () => {
    expect(await svc.read('input', 0, 2)).toEqual([1000, 1001])
  })
  it('FC02 读离散输入（返回 0/1）', async () => {
    expect(await svc.read('discrete', 0, 2)).toEqual([1, 0])
  })
})

describe('ModbusService 写', () => {
  it('FC06 写单寄存器后可读回', async () => {
    await svc.write('holding', 5, [1234])
    expect((await svc.read('holding', 5, 1))[0]).toBe(1234)
  })
  it('FC05 写线圈后可读回', async () => {
    await svc.write('coil', 3, [1])
    expect((await svc.read('coil', 3, 1))[0]).toBe(1)
  })
  it('FC16 写两个寄存器（32 位值）', async () => {
    await svc.write('holding', 20, [0x41CC, 0xCCCD])
    expect(await svc.read('holding', 20, 2)).toEqual([0x41CC, 0xCCCD])
  })
  it('只读区域写入抛错', async () => {
    await expect(svc.write('input', 0, [1])).rejects.toThrow('只读')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/modbus-service.test.js`
Expected: FAIL（modbus-service.js 不存在）

- [ ] **Step 3: 实现 modbus-service.js**

`main/modbus-service.js`:

```js
// main/modbus-service.js — Modbus-TCP 连接与读写封装（单连接单设备）
const ModbusRTU = require('modbus-serial')

const AREA_READERS = {
  coil:     { fn: 'readCoils',            isBit: true },
  discrete: { fn: 'readDiscreteInputs',   isBit: true },
  holding:  { fn: 'readHoldingRegisters', isBit: false },
  input:    { fn: 'readInputRegisters',   isBit: false },
}

// Modbus 异常码 → 现场工程师能看懂的中文提示
const EXCEPTION_HINTS = {
  1: '非法功能码：设备不支持该操作',
  2: '非法数据地址：设备不存在该地址，请检查起始地址和数量',
  3: '非法数据值：写入值不被设备接受',
  4: '设备故障：从站执行请求时发生不可恢复错误',
  6: '设备忙：从站正在处理其他命令，请稍后重试',
}

function friendly(err) {
  if (err?.modbusCode) {
    return new Error(`设备返回异常码 ${err.modbusCode}（${EXCEPTION_HINTS[err.modbusCode] || '未知异常'}）`)
  }
  if (/Timed out/i.test(err?.message || '')) return new Error('请求超时：设备无响应，请检查网络和从站ID')
  if (/Port Not Open/i.test(err?.message || '')) return new Error('连接已断开')
  return err
}

class ModbusService {
  constructor() {
    this.client = null
    this.params = null   // 保存最近一次连接参数，供断线重连
  }

  get connected() { return this.client?.isOpen === true }

  async connect({ host, port = 502, unitId = 1, timeout = 2000 }) {
    await this.disconnect()
    const client = new ModbusRTU()
    await client.connectTCP(host, { port })
    client.setID(unitId)
    client.setTimeout(timeout)
    this.client = client
    this.params = { host, port, unitId, timeout }
  }

  async reconnect() {
    if (!this.params) throw new Error('尚未配置过连接参数')
    await this.connect(this.params)
  }

  async disconnect() {
    if (this.client?.isOpen) await new Promise(r => this.client.close(r))
    this.client = null
  }

  // 读取一个区域，统一返回数值数组（位区域为 0/1，寄存器为 0~65535）
  async read(area, addr, count) {
    const reader = AREA_READERS[area]
    if (!reader) throw new Error(`未知区域类型: ${area}`)
    try {
      const res = await this.client[reader.fn](addr, count)
      return reader.isBit ? res.data.slice(0, count).map(b => (b ? 1 : 0)) : Array.from(res.data)
    } catch (err) { throw friendly(err) }
  }

  // 写入：coil → FC05；holding 1 字 → FC06，2 字 → FC16
  async write(area, addr, words) {
    if (area === 'discrete' || area === 'input') throw new Error('该区域为只读，不支持写入')
    try {
      if (area === 'coil') return await this.client.writeCoil(addr, words[0] === 1)
      if (words.length === 1) return await this.client.writeRegister(addr, words[0])
      return await this.client.writeRegisters(addr, words)
    } catch (err) { throw friendly(err) }
  }
}

module.exports = ModbusService
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/modbus-service.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modbus-service.js test/modbus-service.test.js
git commit -m "feat: ModbusService 连接/读/写（含异常码中文翻译）"
```

---

### Task 7: poller —— 轮询调度、写入队列、断线重连（stub 单测）

**Files:**
- Create: `main/poller.js`
- Test: `test/poller.test.js`

- [ ] **Step 1: 写失败测试**

`test/poller.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Poller from '../main/poller.js'

function stubService(over = {}) {
  return {
    read: vi.fn().mockResolvedValue([1, 2, 3]),
    write: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Poller', () => {
  it('按周期轮询并推送数据', async () => {
    const svc = stubService()
    const p = new Poller(svc)
    const onData = vi.fn()
    p.on('data', onData)
    p.start({ area: 'holding', addr: 0, count: 3, interval: 1000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(onData.mock.calls[0][0].values).toEqual([1, 2, 3])
    expect(svc.read.mock.calls.length).toBeGreaterThanOrEqual(3)
    p.stop()
  })

  it('连续 3 次失败 → offline，恢复后自动 online 并继续轮询', async () => {
    const svc = stubService({ read: vi.fn().mockRejectedValue(new Error('Timed out')) })
    const p = new Poller(svc)
    const onOffline = vi.fn(), onOnline = vi.fn()
    p.on('offline', onOffline)
    p.on('online', onOnline)
    p.on('pollError', () => {})
    p.start({ area: 'holding', addr: 0, count: 1, interval: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(onOffline).toHaveBeenCalledTimes(1)
    svc.read.mockResolvedValue([9])          // 设备恢复
    await vi.advanceTimersByTimeAsync(6000)  // 5s 重连间隔后成功
    expect(svc.reconnect).toHaveBeenCalled()
    expect(onOnline).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('write 直接调用服务并 resolve', async () => {
    const svc = stubService()
    const p = new Poller(svc)
    await p.write('holding', 5, [123])
    expect(svc.write).toHaveBeenCalledWith('holding', 5, [123])
  })

  it('write 失败时 reject 并携带错误消息', async () => {
    const svc = stubService({ write: vi.fn().mockRejectedValue(new Error('设备返回异常码 2')) })
    const p = new Poller(svc)
    await expect(p.write('holding', 5, [1])).rejects.toThrow('异常码 2')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/poller.test.js`
Expected: FAIL（poller.js 不存在）

- [ ] **Step 3: 实现 poller.js**

`main/poller.js`:

```js
// main/poller.js — 轮询调度 + 写入优先队列 + 断线自动重连
// 事件：data { area, addr, values } / pollError (message) / offline / online
// 注意：错误事件命名为 pollError（EventEmitter 的 'error' 无监听会崩进程）
const { EventEmitter } = require('events')

const OFFLINE_THRESHOLD = 3     // 连续失败次数判定断线
const RETRY_INTERVAL = 5000     // 重连间隔 ms

class Poller extends EventEmitter {
  constructor(service) {
    super()
    this.service = service
    this.config = null           // { area, addr, count, interval }
    this.timer = null
    this.retryTimer = null
    this.failCount = 0
    this.writeQueue = []
    this.busy = false            // 一次只允许一个在途请求（Modbus 串行）
  }

  get running() { return this.timer !== null }

  start(config) {
    this.stop()
    this.config = config
    this.failCount = 0
    this.timer = setInterval(() => this._tick(), config.interval)
    this._tick()
  }

  stop() {
    clearInterval(this.timer); this.timer = null
    clearTimeout(this.retryTimer); this.retryTimer = null
  }

  // 写入请求：优先于轮询执行，完成后立即触发一次读回
  write(area, addr, words) {
    const job = new Promise((resolve, reject) => {
      this.writeQueue.push({ area, addr, words, resolve, reject })
    })
    if (!this.busy) {
      this._flushWrites().then(() => { if (this.running) this._tick() })
    }
    return job
  }

  async _flushWrites() {
    while (this.writeQueue.length > 0) {
      const w = this.writeQueue.shift()
      try {
        await this.service.write(w.area, w.addr, w.words)
        w.resolve()
      } catch (err) { w.reject(err) }
    }
  }

  async _tick() {
    if (this.busy || !this.config) return
    this.busy = true
    try {
      const { area, addr, count } = this.config
      const values = await this.service.read(area, addr, count)
      this.failCount = 0
      this.emit('data', { area, addr, values })
      await this._flushWrites()   // 读的间隙处理排队的写
    } catch (err) {
      this.failCount++
      this.emit('pollError', err.message)
      if (this.failCount >= OFFLINE_THRESHOLD) this._goOffline()
    } finally {
      this.busy = false
    }
  }

  _goOffline() {
    clearInterval(this.timer); this.timer = null
    this.emit('offline')
    const retry = async () => {
      try {
        await this.service.reconnect()
        this.emit('online')
        if (this.config) this.start(this.config)   // 恢复后自动继续监控
      } catch {
        this.retryTimer = setTimeout(retry, RETRY_INTERVAL)
      }
    }
    this.retryTimer = setTimeout(retry, RETRY_INTERVAL)
  }
}

module.exports = Poller
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/poller.test.js`
Expected: PASS

- [ ] **Step 5: 跑全量测试防回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add main/poller.js test/poller.test.js
git commit -m "feat: Poller 轮询调度/写入队列/断线重连（TDD）"
```

---

### Task 8: activation —— 激活验证客户端（verifyToken 单测）

**Files:**
- Create: `main/activation.js`
- Test: `test/activation.test.js`

- [ ] **Step 1: 写失败测试**

`test/activation.test.js`:

```js
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyToken } from '../main/activation.js'

const KEY = 'test-key'
const makeToken = (code, expires) =>
  crypto.createHmac('sha256', KEY).update(`${code}.${expires}`).digest('hex')
const daysFromNow = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)

describe('verifyToken 本地验签', () => {
  it('合法且未过期通过', () => {
    const exp = daysFromNow(10)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(true)
  })
  it('签名不匹配拒绝', () => {
    const exp = daysFromNow(10)
    expect(verifyToken('ABCD-2345', 'bad-token', exp, KEY)).toBe(false)
  })
  it('过期 3 天（宽限期内）通过', () => {
    const exp = daysFromNow(-3)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(true)
  })
  it('过期 8 天（超宽限期）拒绝', () => {
    const exp = daysFromNow(-8)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(false)
  })
  it('缺字段拒绝', () => {
    expect(verifyToken(null, 'x', daysFromNow(1), KEY)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/activation.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 activation.js**

`main/activation.js`:

```js
// main/activation.js — 激活验证：服务端换 Token + 本地 HMAC 验签（30 天 + 7 天宽限）
// 部署激活服务后，回填下方 VERIFY_URLS 与 SIGN_KEY（见 Task 14）
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const VERIFY_URLS = [
  'https://REPLACE-WITH-SCF-URL/verify',       // 腾讯云 SCF（主，国内直连）
  'https://REPLACE-WITH-WORKER-URL/verify',    // Cloudflare Worker（备）
]
const SIGN_KEY = 'REPLACE_WITH_SIGN_KEY'       // 与服务端 SIGN_KEY 一致
const GRACE_MS = 7 * 24 * 60 * 60 * 1000       // 断网宽限 7 天
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

// 纯函数便于单测：验签 Token（无需联网）
function verifyToken(code, token, expires, signKey) {
  if (!code || !token || !expires) return false
  if (Date.now() > new Date(expires).getTime() + GRACE_MS) return false
  const expected = crypto.createHmac('sha256', signKey).update(`${code}.${expires}`).digest('hex')
  return expected === token
}

class Activation {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'activation.json')
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return {} } }
  _save(data) { fs.writeFileSync(this.file, JSON.stringify(data)) }

  // 持久化设备 ID（一码一设备绑定用）
  getDeviceId() {
    const d = this._load()
    if (d.deviceId) return d.deviceId
    const deviceId = crypto.randomUUID()
    this._save({ ...d, deviceId })
    return deviceId
  }

  isActivated() {
    if (process.env.MM_DEV === '1') return true   // 开发模式跳过激活
    const { code, token, expires } = this._load()
    return verifyToken(code, token, expires, SIGN_KEY)
  }

  // 服务端验证激活码，成功则缓存 Token；返回 { ok } 或 { ok:false, error:中文提示 }
  async activate(inputCode) {
    const code = String(inputCode).trim().toUpperCase().replace(/\s/g, '')
    if (!CODE_RE.test(code)) return { ok: false, error: '激活码格式不正确，应为 XXXX-XXXX' }
    const deviceId = this.getDeviceId()
    for (const url of VERIFY_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceId }),
          signal: AbortSignal.timeout(8000),
        })
        const data = await res.json()
        if (data.ok) {
          this._save({ ...this._load(), code, token: data.token, expires: data.expires })
          return { ok: true }
        }
        if (data.error === 'code_already_used') return { ok: false, error: '该激活码已在其他设备使用，请联系作者' }
        if (data.error === 'revoked') return { ok: false, error: '该激活码已被停用，请联系作者' }
        if (data.error === 'invalid_code') return { ok: false, error: '激活码无效，请检查输入' }
      } catch { /* 当前节点超时/失败，尝试下一个 */ }
    }
    return { ok: false, error: '无法连接激活服务器，请检查网络后重试' }
  }
}

module.exports = { Activation, verifyToken }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/activation.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/activation.js test/activation.test.js
git commit -m "feat: 激活验证客户端（Token 本地验签 + 双节点服务端验证）"
```

---

### Task 9: 激活服务端代码（从 MicroDramaHelper 复制并改名）

激活服务端方案已在 MicroDramaHelper 项目验证过，代码本身与产品无关（密钥全部走环境变量），复制后只需改名。

**Files:**
- Create: `workers/index.js`、`workers/wrangler.toml`（复制）
- Create: `scf/index.js`（复制）
- Create: `scripts/generate-codes.js`（复制 + 密钥改环境变量）

- [ ] **Step 1: 复制文件**

```bash
mkdir -p scf workers scripts
cp ../MicroDramaHelper/workers/index.js workers/index.js
cp ../MicroDramaHelper/workers/wrangler.toml workers/wrangler.toml
cp ../MicroDramaHelper/scf/index.js scf/index.js
cp ../MicroDramaHelper/scripts/generate-codes.js scripts/generate-codes.js
```

- [ ] **Step 2: 全局改名（产品标识与 KV 绑定名）**

```bash
sed -i '' 's/MicroDramaHelper/ModbusMate/g; s/MDH_KV/MM_KV/g' workers/index.js scf/index.js
grep -n 'MicroDramaHelper\|MDH\|mdh' workers/index.js scf/index.js scripts/generate-codes.js || echo '（剩余命中见上，逐个确认是否需要改）'
```

对 grep 命中的剩余位置逐个检查：凡属产品名/绑定名的改为 ModbusMate/MM 前缀；`SECRET`、`SIGN_KEY`、`ADMIN_KEY`、`COS_*` 这些环境变量名保持不变。

- [ ] **Step 3: wrangler.toml 改服务名**

编辑 `workers/wrangler.toml`：`name` 字段改为 `"modbusmate-verify"`；若有 KV 绑定段，绑定变量名改为 `MM_KV`（KV 的 `id` 留待 Task 14 部署时填写）。

- [ ] **Step 4: generate-codes.js 密钥改为环境变量**

打开 `scripts/generate-codes.js`，找到硬编码密钥行：

```js
const SECRET = 'mdh@admin2026'
```

替换为：

```js
// 密钥从环境变量读取，不落盘、不入库
const SECRET = process.env.MM_SECRET
if (!SECRET) {
  console.error('缺少环境变量 MM_SECRET。用法：MM_SECRET=<密钥> node scripts/generate-codes.js 100')
  process.exit(1)
}
```

- [ ] **Step 5: 验证生成脚本可运行**

Run: `MM_SECRET=test-secret node scripts/generate-codes.js 5 && head -5 codes.txt && rm codes.txt`
Expected: 输出 5 个 `XXXX-XXXX` 格式激活码

- [ ] **Step 6: Commit**

```bash
git add workers scf scripts/generate-codes.js
git commit -m "feat: 激活服务端（SCF 主 + Worker 备）与激活码生成脚本"
```

---

### Task 10: 主进程 IPC 接线 + preload 桥接 + 配置持久化

**Files:**
- Modify: `main/index.js`（全量替换 Task 1 的最小版）
- Modify: `preload.js`（全量替换）

- [ ] **Step 1: 全量替换 main/index.js**

```js
// main/index.js — 主进程入口：窗口、IPC 接线、配置持久化、崩溃日志
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const ModbusService = require('./modbus-service')
const Poller = require('./poller')
const { Activation } = require('./activation')

const service = new ModbusService()
const poller = new Poller(service)
let activation = null
let win = null

// ── 崩溃级错误落盘，便于远程排查用户问题 ──
process.on('uncaughtException', err => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] ${err.stack}\n`)
  } catch { /* 日志写入失败不再抛出 */ }
})

// ── 配置持久化（连接参数 + 监控配置）──
const configFile = () => path.join(app.getPath('userData'), 'config.json')
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch { return {} } }
function saveConfig(cfg) { fs.writeFileSync(configFile(), JSON.stringify(cfg)) }

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 680, minWidth: 800, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

function send(channel, payload) { win?.webContents.send(channel, payload) }

function registerIpc() {
  ipcMain.handle('modbus:connect', async (_e, params) => {
    await service.connect(params)
    send('modbus:status', { state: 'connected' })
  })
  ipcMain.handle('modbus:disconnect', async () => {
    poller.stop()
    await service.disconnect()
    send('modbus:status', { state: 'disconnected' })
  })
  ipcMain.handle('modbus:startPoll', (_e, cfg) => poller.start(cfg))
  ipcMain.handle('modbus:stopPoll', () => poller.stop())
  ipcMain.handle('modbus:write', (_e, { area, addr, words }) =>
    poller.running ? poller.write(area, addr, words) : service.write(area, addr, words))
  ipcMain.handle('config:load', () => loadConfig())
  ipcMain.handle('config:save', (_e, cfg) => saveConfig(cfg))
  ipcMain.handle('activation:status', () => activation.isActivated())
  ipcMain.handle('activation:verify', (_e, code) => activation.activate(code))

  poller.on('data', d => send('modbus:data', d))
  poller.on('pollError', msg => send('modbus:log', { level: 'error', message: `读取失败：${msg}` }))
  poller.on('offline', () => send('modbus:status', { state: 'offline' }))
  poller.on('online', () => send('modbus:status', { state: 'connected' }))
}

app.whenReady().then(() => {
  activation = new Activation(app.getPath('userData'))
  registerIpc()
  createWindow()
})
app.on('window-all-closed', () => app.quit())
```

- [ ] **Step 2: 全量替换 preload.js**

```js
// preload.js — IPC 白名单桥接：渲染层只能访问这里显式暴露的 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  connect:          p    => ipcRenderer.invoke('modbus:connect', p),
  disconnect:       ()   => ipcRenderer.invoke('modbus:disconnect'),
  startPoll:        c    => ipcRenderer.invoke('modbus:startPoll', c),
  stopPoll:         ()   => ipcRenderer.invoke('modbus:stopPoll'),
  write:            w    => ipcRenderer.invoke('modbus:write', w),
  loadConfig:       ()   => ipcRenderer.invoke('config:load'),
  saveConfig:       c    => ipcRenderer.invoke('config:save', c),
  activationStatus: ()   => ipcRenderer.invoke('activation:status'),
  activationVerify: code => ipcRenderer.invoke('activation:verify', code),
  onData:   fn => ipcRenderer.on('modbus:data',   (_e, d) => fn(d)),
  onStatus: fn => ipcRenderer.on('modbus:status', (_e, s) => fn(s)),
  onLog:    fn => ipcRenderer.on('modbus:log',    (_e, l) => fn(l)),
})
```

- [ ] **Step 3: 验证应用仍能启动（开发模式跳过激活）**

Run: `npm run dev`
Expected: 窗口打开（仍是占位页面），终端无报错，手动关闭

- [ ] **Step 4: Commit**

```bash
git add main/index.js preload.js
git commit -m "feat: 主进程 IPC 接线、配置持久化、崩溃日志"
```

---

### Task 11: 渲染层界面（HTML + CSS + app.js 全量）

**Files:**
- Modify: `renderer/index.html`（全量替换）
- Create: `renderer/style.css`
- Create: `renderer/app.js`

- [ ] **Step 1: 全量替换 renderer/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>ModbusMate</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- 激活遮罩 -->
  <div id="activationOverlay" class="overlay hidden">
    <div class="activation-box">
      <h2>激活 ModbusMate</h2>
      <p>请输入激活码（格式 XXXX-XXXX）</p>
      <input id="codeInput" maxlength="9" placeholder="XXXX-XXXX" autocomplete="off">
      <div id="codeError" class="error-text"></div>
      <button id="activateBtn">激活</button>
    </div>
  </div>

  <div id="app" class="hidden">
    <!-- 连接栏 -->
    <div class="bar">
      <label>IP <input id="host" placeholder="192.168.1.10"></label>
      <label>端口 <input id="port" type="number" value="502"></label>
      <label>从站ID <input id="unitId" type="number" value="1"></label>
      <button id="connectBtn">连接</button>
      <span id="statusDot" class="dot disconnected"></span>
      <span id="statusText">未连接</span>
      <label class="right"><input id="plcMode" type="checkbox" checked> PLC 地址(4xxxx)</label>
    </div>

    <!-- 监控配置栏 -->
    <div class="bar">
      <label>区域
        <select id="area">
          <option value="holding" selected>保持寄存器(FC03)</option>
          <option value="input">输入寄存器(FC04)</option>
          <option value="coil">线圈(FC01)</option>
          <option value="discrete">离散输入(FC02)</option>
        </select>
      </label>
      <label>起始地址 <input id="startAddr" type="number" value="0"></label>
      <label>数量 <input id="count" type="number" value="10" min="1" max="120"></label>
      <label>周期
        <select id="interval">
          <option value="100">100ms</option>
          <option value="500">500ms</option>
          <option value="1000" selected>1s</option>
          <option value="2000">2s</option>
          <option value="5000">5s</option>
          <option value="10000">10s</option>
        </select>
      </label>
      <button id="pollBtn">▶ 开始监控</button>
    </div>

    <!-- 监控表格 -->
    <div class="table-wrap">
      <table>
        <thead><tr><th>地址</th><th>数据类型</th><th>原始值</th><th>解析值</th><th>操作</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>

    <!-- 日志栏 -->
    <div id="logPanel">
      <div id="logToggle" class="log-header">通信日志 ▾</div>
      <div id="logBox"></div>
    </div>
  </div>

  <!-- 写入弹窗 -->
  <div id="writeModal" class="overlay hidden">
    <div class="modal-box">
      <h3 id="modalTitle"></h3>
      <p id="modalHint" class="hint"></p>
      <input id="modalInput" autocomplete="off">
      <div id="modalError" class="error-text"></div>
      <div class="modal-btns">
        <button id="modalCancel">取消</button>
        <button id="modalOk">写入</button>
      </div>
    </div>
  </div>

  <script src="codec.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 renderer/style.css**

```css
/* renderer/style.css — ModbusMate 界面样式 */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #222; height: 100vh; }
.hidden { display: none !important; }
#app { display: flex; flex-direction: column; height: 100vh; }

/* 顶部两条工具栏 */
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #e2e4e8; flex-wrap: wrap; }
.bar label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.bar input, .bar select { padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; width: 90px; }
#host { width: 130px; }
.right { margin-left: auto; }
button { padding: 5px 14px; border: 1px solid #3a6df0; background: #3a6df0; color: #fff; border-radius: 4px; cursor: pointer; }
button:hover { opacity: .88; }
button:disabled { opacity: .5; cursor: not-allowed; }

/* 连接状态灯 */
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.connected { background: #2fbf4f; }
.dot.disconnected { background: #aaa; }
.dot.offline, .dot.error { background: #e5484d; }
.dot.connecting { background: #f5b50a; }

/* 监控表格 */
.table-wrap { flex: 1; overflow: auto; padding: 8px 12px; }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { padding: 6px 10px; border: 1px solid #e8eaee; text-align: left; }
th { background: #eef1f5; position: sticky; top: 0; }
tr.flash td { background: #fff3b0; }
tr.occupied td { opacity: .45; }
td select { padding: 2px 4px; margin-right: 4px; }
.writeBtn { padding: 2px 10px; font-size: 12px; }

/* 日志栏 */
#logPanel { border-top: 1px solid #e2e4e8; background: #fff; }
.log-header { padding: 6px 12px; cursor: pointer; user-select: none; background: #eef1f5; font-weight: 600; }
#logBox { height: 130px; overflow-y: auto; padding: 6px 12px; font-family: Menlo, Consolas, monospace; font-size: 12px; }
#logPanel.collapsed #logBox { display: none; }
.log-error { color: #e5484d; }
.log-info { color: #555; }

/* 遮罩与弹窗（激活 / 写入共用 overlay） */
.overlay { position: fixed; inset: 0; background: rgba(20,24,32,.55); display: flex; align-items: center; justify-content: center; z-index: 10; }
.activation-box, .modal-box { background: #fff; border-radius: 10px; padding: 28px 32px; width: 340px; text-align: center; }
.activation-box h2 { margin-bottom: 8px; }
.activation-box p, .hint { color: #777; margin-bottom: 14px; font-size: 12px; }
.activation-box input, .modal-box input { width: 100%; padding: 8px; font-size: 16px; text-align: center; border: 1px solid #ccc; border-radius: 6px; letter-spacing: 2px; }
.activation-box button { width: 100%; margin-top: 14px; padding: 8px; }
.error-text { color: #e5484d; font-size: 12px; min-height: 18px; margin-top: 6px; }
.modal-btns { display: flex; gap: 10px; margin-top: 14px; }
.modal-btns button { flex: 1; }
#modalCancel { background: #fff; color: #444; border-color: #ccc; }
```

- [ ] **Step 3: 写 renderer/app.js**

```js
// renderer/app.js — 界面逻辑（依赖 codec.js 暴露的全局 Codec 与 preload 暴露的 window.api）
const $ = id => document.getElementById(id)

const state = {
  connected: false,
  polling: false,
  area: 'holding', addr: 0, count: 10, interval: 1000,
  rows: [],          // 每行 { type, wordOrder }；位区域行为 { type: 'bit' }
  values: [],        // 最新原始值
  prevValues: [],    // 上一轮值，用于变化高亮
  plcMode: true,
}

const isBitArea = () => state.area === 'coil' || state.area === 'discrete'
const isWritableArea = () => state.area === 'coil' || state.area === 'holding'
// IPC 抛错带 "Error invoking remote method 'xx': Error: " 前缀，剥掉只留业务消息
const cleanErr = msg => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ── 入口：先过激活，再进主应用 ──
async function init() {
  if (await window.api.activationStatus()) return startApp()
  $('activationOverlay').classList.remove('hidden')
  const input = $('codeInput'), btn = $('activateBtn'), err = $('codeError')
  input.addEventListener('input', () => {
    let v = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)
    if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4)
    input.value = v
    err.textContent = ''
  })
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = '验证中…'
    const res = await window.api.activationVerify(input.value)
    if (res.ok) {
      $('activationOverlay').classList.add('hidden')
      startApp()
    } else {
      err.textContent = res.error
      btn.disabled = false; btn.textContent = '激活'
    }
  })
}

async function startApp() {
  $('app').classList.remove('hidden')
  // 恢复上次配置
  const cfg = await window.api.loadConfig()
  if (cfg.host) $('host').value = cfg.host
  if (cfg.port) $('port').value = cfg.port
  if (cfg.unitId) $('unitId').value = cfg.unitId
  if (cfg.area) $('area').value = cfg.area
  if (cfg.addr !== undefined) $('startAddr').value = cfg.addr
  if (cfg.count) $('count').value = cfg.count
  if (cfg.interval) $('interval').value = cfg.interval

  $('connectBtn').addEventListener('click', onConnectClick)
  $('pollBtn').addEventListener('click', onPollClick)
  $('plcMode').addEventListener('change', () => { state.plcMode = $('plcMode').checked; renderTable() })
  $('logToggle').addEventListener('click', () => $('logPanel').classList.toggle('collapsed'))
  $('modalCancel').addEventListener('click', closeModal)
  $('modalOk').addEventListener('click', confirmWrite)

  window.api.onData(onData)
  window.api.onStatus(st => onStatus(st))
  window.api.onLog(l => log(l.level, l.message))
  log('info', 'ModbusMate 就绪，请连接设备')
}

// ── 连接 ──
async function onConnectClick() {
  if (state.connected) return window.api.disconnect()
  const params = { host: $('host').value.trim(), port: Number($('port').value), unitId: Number($('unitId').value) }
  if (!params.host) return log('error', '请输入设备 IP 地址')
  setStatus('connecting')
  try {
    await window.api.connect(params)
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, ...params })
    log('info', `已连接 ${params.host}:${params.port}（从站 ${params.unitId}）`)
  } catch (err) {
    setStatus('error')
    log('error', `连接失败：${friendlyConnectError(cleanErr(err.message), params)}`)
  }
}

function friendlyConnectError(msg, p) {
  if (msg.includes('ECONNREFUSED')) return `${p.host}:${p.port} 拒绝连接，请确认设备已开启 Modbus-TCP 服务、端口号正确`
  if (msg.includes('EHOSTUNREACH') || msg.includes('ETIMEDOUT') || /Timed out/i.test(msg)) return `${p.host}:${p.port} 无响应，请检查设备电源、网线和 IP 设置`
  if (msg.includes('ENOTFOUND')) return `找不到主机 ${p.host}，请检查 IP 地址`
  return msg
}

function setStatus(s) {
  state.connected = s === 'connected'
  $('statusDot').className = 'dot ' + s
  const labels = { connected: '已连接', disconnected: '未连接', offline: '连接中断，自动重连中…', connecting: '连接中…', error: '连接失败' }
  $('statusText').textContent = labels[s] || s
  $('connectBtn').textContent = state.connected ? '断开' : '连接'
  if (s === 'disconnected' || s === 'error') {
    state.polling = false
    $('pollBtn').textContent = '▶ 开始监控'
  }
}

function onStatus(st) {
  setStatus(st.state)
  if (st.state === 'offline') log('error', '设备连接中断，每 5 秒自动重连…')
  if (st.state === 'connected' && state.polling) log('info', '连接已恢复，继续监控')
}

// ── 监控 ──
async function onPollClick() {
  if (state.polling) {
    await window.api.stopPoll()
    state.polling = false
    $('pollBtn').textContent = '▶ 开始监控'
    return
  }
  if (!state.connected) return log('error', '请先连接设备')
  const area = $('area').value
  const addr = Number($('startAddr').value)
  const count = Number($('count').value)
  const interval = Number($('interval').value)
  if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return log('error', '起始地址应为 0~65535 的整数（协议地址，从 0 起）')
  if (!Number.isInteger(count) || count < 1 || count > 120) return log('error', '数量应为 1~120 的整数')

  const areaChanged = area !== state.area
  Object.assign(state, { area, addr, count, interval })
  const bit = isBitArea()
  // 区域类型不变时保留每行已设置的数据类型
  state.rows = Array.from({ length: count }, (_, i) =>
    bit ? { type: 'bit' } : (!areaChanged && state.rows[i] && state.rows[i].type !== 'bit' ? state.rows[i] : { type: 'uint16', wordOrder: 'AB' }))
  state.values = []
  state.prevValues = []
  renderTable()

  await window.api.startPoll({ area, addr, count, interval })
  const cfg = await window.api.loadConfig()
  await window.api.saveConfig({ ...cfg, area, addr, count, interval })
  state.polling = true
  $('pollBtn').textContent = '⏸ 停止监控'
  log('info', `开始监控 ${area} 区域，地址 ${addr} 起 ${count} 点，周期 ${interval}ms`)
}

function onData(d) {
  state.prevValues = state.values
  state.values = d.values
  renderValues()
}

// ── 表格 ──
// 计算被上一行 32 位类型占用的行
function computeOccupied() {
  const occ = new Array(state.count).fill(false)
  for (let i = 0; i < state.count; i++) {
    if (occ[i]) continue
    const r = state.rows[i]
    if (r && Codec.TYPES[r.type]?.words === 2) occ[i + 1] = true
  }
  return occ
}

function renderTable() {
  const tbody = $('tbody')
  tbody.innerHTML = ''
  const bit = isBitArea()
  const writable = isWritableArea()
  for (let i = 0; i < state.count; i++) {
    const tr = document.createElement('tr')
    tr.dataset.index = i
    const protoAddr = state.addr + i
    const dispAddr = state.plcMode ? Codec.toPlcAddress(protoAddr, state.area) : protoAddr
    let typeCell
    if (bit) {
      typeCell = '<td>开关量</td>'
    } else {
      const row = state.rows[i]
      const opts = Object.entries(Codec.TYPES)
        .map(([k, t]) => `<option value="${k}" ${row.type === k ? 'selected' : ''}>${t.label}</option>`).join('')
      const orderHidden = Codec.TYPES[row.type].words === 2 ? '' : 'hidden'
      typeCell = `<td><select class="typeSel">${opts}</select><select class="orderSel ${orderHidden}"><option ${row.wordOrder === 'AB' ? 'selected' : ''}>AB</option><option ${row.wordOrder === 'BA' ? 'selected' : ''}>BA</option></select></td>`
    }
    tr.innerHTML = `<td>${dispAddr}</td>${typeCell}<td class="raw">—</td><td class="parsed">—</td><td>${writable ? '<button class="writeBtn">写入</button>' : ''}</td>`
    tbody.appendChild(tr)
  }
  tbody.querySelectorAll('.typeSel').forEach(sel => sel.addEventListener('change', e => {
    const i = Number(e.target.closest('tr').dataset.index)
    state.rows[i].type = e.target.value
    renderTable()   // 32 位占位可能变化，整表重建
  }))
  tbody.querySelectorAll('.orderSel').forEach(sel => sel.addEventListener('change', e => {
    const i = Number(e.target.closest('tr').dataset.index)
    state.rows[i].wordOrder = e.target.value
    renderValues()
  }))
  tbody.querySelectorAll('.writeBtn').forEach(btn => btn.addEventListener('click', e => {
    openWriteModal(Number(e.target.closest('tr').dataset.index))
  }))
  renderValues()
}

function renderValues() {
  const bit = isBitArea()
  const occ = bit ? [] : computeOccupied()
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const i = Number(tr.dataset.index)
    const rawCell = tr.querySelector('.raw')
    const parsedCell = tr.querySelector('.parsed')
    const v = state.values[i]
    if (occ[i]) {
      rawCell.textContent = '—'
      parsedCell.textContent = '（由上行 32 位占用）'
      tr.classList.add('occupied')
      return
    }
    tr.classList.remove('occupied')
    if (v === undefined) { rawCell.textContent = '—'; parsedCell.textContent = '—'; return }
    if (bit) {
      rawCell.textContent = v
      parsedCell.textContent = v ? 'ON' : 'OFF'
    } else {
      rawCell.textContent = '0x' + v.toString(16).toUpperCase().padStart(4, '0')
      const { type, wordOrder } = state.rows[i]
      const parsed = Codec.decode(state.values, i, type, wordOrder)
      parsedCell.textContent = parsed === null ? '（缺下一寄存器）'
        : (typeof parsed === 'number' && !Number.isInteger(parsed) ? parsed.toFixed(4) : String(parsed))
    }
    // 变化高亮：值与上一轮不同则闪烁
    if (state.prevValues.length > 0 && state.prevValues[i] !== v) {
      tr.classList.add('flash')
      setTimeout(() => tr.classList.remove('flash'), 600)
    }
  })
}

// ── 写入弹窗 ──
let writeTarget = null

function openWriteModal(i) {
  const coil = state.area === 'coil'
  const row = state.rows[i]
  writeTarget = { index: i }
  const dispAddr = state.plcMode ? Codec.toPlcAddress(state.addr + i, state.area) : state.addr + i
  $('modalTitle').textContent = `写入地址 ${dispAddr}（${coil ? '线圈' : Codec.TYPES[row.type].label}）`
  $('modalHint').textContent = coil ? '输入 1=ON，0=OFF'
    : row.type === 'hex' ? '输入十六进制，如 1A2B' : '输入数值'
  $('modalInput').value = ''
  $('modalError').textContent = ''
  $('writeModal').classList.remove('hidden')
  $('modalInput').focus()
}

function closeModal() {
  $('writeModal').classList.add('hidden')
  writeTarget = null
}

async function confirmWrite() {
  if (!writeTarget) return
  const i = writeTarget.index
  const raw = $('modalInput').value.trim()
  let words
  try {
    if (state.area === 'coil') {
      if (raw !== '0' && raw !== '1') throw new Error('线圈只能写 0 或 1')
      words = [Number(raw)]
    } else {
      const { type, wordOrder } = state.rows[i]
      words = Codec.encode(raw, type, wordOrder)
    }
  } catch (err) {
    $('modalError').textContent = err.message
    return
  }
  try {
    await window.api.write({ area: state.area, addr: state.addr + i, words })
    log('info', `写入成功：地址 ${state.addr + i} ← ${raw}`)
    closeModal()
  } catch (err) {
    $('modalError').textContent = `写入失败：${cleanErr(err.message)}`
  }
}

// ── 日志（环形缓冲 200 条）──
const logs = []
function log(level, message) {
  const time = new Date().toTimeString().slice(0, 8)
  logs.push({ time, level, message })
  if (logs.length > 200) logs.shift()
  const box = $('logBox')
  box.innerHTML = logs.map(l => `<div class="log-${l.level}">[${l.time}] ${l.message}</div>`).join('')
  box.scrollTop = box.scrollHeight
}

document.addEventListener('DOMContentLoaded', init)
```

- [ ] **Step 4: 跑全量测试防回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/style.css renderer/app.js
git commit -m "feat: 渲染层界面 — 连接/监控表格/写入/日志/激活"
```

---

### Task 12: 端到端手动验证（模拟器 + 应用）

**Files:** 无新文件，验证 + 修复

- [ ] **Step 1: 启动模拟器（保持运行）**

Run: `npm run sim`（另开一个终端，或后台运行）
Expected: "模拟从站已启动: 127.0.0.1:8502"

- [ ] **Step 2: 启动应用并逐项验证**

Run: `npm run dev`（MM_DEV=1 跳过激活）

验证清单（在窗口中操作）：

1. 连接 `127.0.0.1` 端口 `8502` 从站 `1` → 状态灯变绿、日志显示"已连接"
2. 区域"保持寄存器"、起始 `0`、数量 `15`、周期 `1s`，点"开始监控" → 表格出现 15 行，40001 行解析值 `250`
3. 观察 40011 行（协议地址 10）每秒数值 +1 且黄色闪烁
4. 将 40003 行类型改为 `Float32`、字序 `AB` → 解析值 `25.6000`，40004 行显示"（由上行 32 位占用）"
5. 点 40006 行"写入"，输入 `1234` → 日志"写入成功"，下一周期表格显示 1234
6. 40003 行（Float32）写入 `3.14` → 成功，解析值变为 `3.1400`
7. 切区域为"线圈"，起始 `0` 数量 `8`，开始监控 → 显示 OFF；对地址 3 写 `1` → 变 ON
8. 切"输入寄存器" → 无"写入"按钮，值为 1000、1001…
9. 取消勾选"PLC 地址" → 地址列变为 0 起协议地址
10. 停掉模拟器（Ctrl+C）→ 约 3 个周期后状态变"连接中断，自动重连中…"；重新 `npm run sim` → 5s 内恢复"已连接"并继续刷新
11. 写入弹窗输入超范围值（如 UInt16 输入 `70000`）→ 弹窗内显示"UInt16 取值范围 0 ~ 65535"
12. 重启应用 → 连接参数和监控配置自动恢复

- [ ] **Step 3: 修复发现的问题（如有），跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: 端到端联调问题修复"
```

---

### Task 13: 打包配置 + README

**Files:**
- Modify: `package.json`（追加 build 配置）
- Create: `README.md`

- [ ] **Step 1: package.json 追加 electron-builder 配置**

在 `package.json` 顶层追加 `"build"` 键：

```json
  "build": {
    "appId": "com.yaominghua.modbusmate",
    "productName": "ModbusMate",
    "files": ["main/**", "renderer/**", "preload.js", "package.json"],
    "directories": { "output": "release" },
    "win": { "target": ["nsis", "portable"] },
    "mac": { "target": "dmg" }
  }
```

同时在 `.gitignore` 追加一行 `release/`。

- [ ] **Step 2: 验证 Mac 打包**

Run: `npm run dist`
Expected: `release/` 下生成 `ModbusMate-0.1.0.dmg`（无签名警告属正常）
（Windows 包需在 Windows 机器上跑 `npm run dist`，或后续用 CI；本步只验证 Mac）

- [ ] **Step 3: 写 README.md**

```markdown
# ModbusMate

> 通用 Modbus-TCP 调试工具：轮询监控 · 单点写入 · 数据类型解析（Windows / Mac 桌面应用）

## 功能

- **轮询监控**：连接任意 Modbus-TCP 设备（FC01–FC04 四区域），按周期实时刷新表格，数值变化高亮
- **指令下发**：线圈 FC05、寄存器 FC06（32 位类型自动用 FC16 写两个寄存器），写后立即回读确认
- **数据解析**：Int16 / UInt16 / Int32 / UInt32 / Float32（AB/BA 字序）/ Hex，每行独立设置
- **地址模式**：PLC 习惯地址（40001 起）与协议地址（0 起）一键切换
- **断线重连**：连续 3 次读失败自动进入重连，每 5 秒重试，恢复后继续监控
- **激活授权**：激活码 + 设备绑定 + 服务端验证（30 天 Token 本地验签，7 天断网宽限）

## 开发

​```bash
npm install          # 安装依赖
npm run dev          # 开发模式启动（MM_DEV=1 跳过激活）
npm test             # 单元测试（codec/poller/service/activation）
npm run sim          # 启动本地 Modbus-TCP 模拟从站（127.0.0.1:8502）
npm run dist         # 打包（Mac 出 dmg；Windows 上运行出 NSIS + 便携版）
​```

## 激活服务

服务端代码在 `scf/`（腾讯云 SCF，主节点）与 `workers/`（Cloudflare Worker，备用节点），
部署方法与密钥配置见 `docs/plans/2026-07-03-modbusmate-impl.md` Task 14。

生成激活码：`MM_SECRET=<密钥> node scripts/generate-codes.js 100`（输出 codes.txt，已被 gitignore）

## 文档

- 设计规格：`docs/specs/2026-07-03-modbusmate-design.md`
- 实施计划：`docs/plans/2026-07-03-modbusmate-impl.md`
```

（注意：上面代码块内的 ​``` 转义仅为本计划文档展示用，写入 README 时用正常的三反引号。）

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore README.md
git commit -m "chore: electron-builder 打包配置与 README"
```

---

### Task 14: 部署激活服务并回填密钥（需要姚鸣华操作）

此任务涉及云账号凭证，由用户本人执行；执行代理跑到这里时应停下来提示用户。

- [ ] **Step 1: 生成生产密钥（本地保管，勿提交）**

```bash
openssl rand -hex 16   # 作为 SECRET（激活码密钥）
openssl rand -hex 32   # 作为 SIGN_KEY（Token 签名密钥）
openssl rand -hex 16   # 作为 ADMIN_KEY（吊销接口管理密钥）
```

- [ ] **Step 2: 部署 Cloudflare Worker（备用节点）**

```bash
cd workers
npx wrangler kv namespace create MM_KV     # 把返回的 id 填进 wrangler.toml
npx wrangler deploy
npx wrangler secret put SECRET
npx wrangler secret put SIGN_KEY
npx wrangler secret put ADMIN_KEY
```

记录部署后的 `*.workers.dev` 地址。

- [ ] **Step 3: 部署腾讯云 SCF（主节点）**

在腾讯云控制台创建 Web 函数，上传 `scf/index.js`，配置环境变量：`SECRET`、`SIGN_KEY`（与 Worker 相同值）、`COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`（COS 桶做设备绑定存储）。记录函数 URL。

- [ ] **Step 4: 回填客户端**

编辑 `main/activation.js`：
- `VERIFY_URLS[0]` ← SCF 函数 URL + `/verify`
- `VERIFY_URLS[1]` ← Worker URL + `/verify`
- `SIGN_KEY` ← Step 1 生成的 SIGN_KEY

- [ ] **Step 5: 生成激活码并真实验证**

```bash
MM_SECRET=<Step1 的 SECRET> node scripts/generate-codes.js 10
npm start    # 不带 MM_DEV，走真实激活流程，输入一个激活码验证通过
```

Expected: 激活成功进入主界面；重启应用不再要求激活；换一个"已用码"提示设备绑定错误

- [ ] **Step 6: Commit（只提交 URL 回填，密钥不入库）**

```bash
git add main/activation.js
git commit -m "chore: 回填激活服务地址"
```

---

## 自审记录

- **规格覆盖**：轮询监控（T7/T11）、单点写入含 FC05/06/16（T6/T11）、数据类型与字序（T2/T3）、PLC 地址（T4/T11）、断线重连（T7）、变化高亮（T11）、日志与中文错误（T6/T11）、配置持久化（T10/T11）、激活授权（T8/T9/T14）、模拟器测试（T5/T6）、打包（T13）——全部有对应任务
- **占位符**：`main/activation.js` 中 REPLACE 常量是刻意设计（部署后由 T14 回填），非计划缺口
- **类型一致性**：`read()/write()` 签名、`Codec` API、IPC 通道名、事件名（`pollError`）在各任务间已核对一致
