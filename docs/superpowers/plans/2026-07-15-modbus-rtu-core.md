# Modbus TCP/RTU Unified Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 Modbus-TCP 行为的前提下，建立统一传输层并支持 macOS/Windows 的 Modbus-RTU 连接、串口枚举、读写和重连。

**Architecture:** `ModbusService` 保持现有公共接口，内部通过工厂创建 TCP 或 RTU Transport。共享基类负责区域读写、中文错误和客户端生命周期，TCP/RTU 子类只负责打开连接；配置校验和串口枚举保持独立，以便 Electron 与后续网页服务复用。

**Tech Stack:** Node.js CommonJS、modbus-serial 8、serialport 13、Electron IPC、Vitest 3

---

## 文件结构

- Create: `main/connection-config.js` — TCP/RTU 配置规范化、默认值和校验。
- Create: `main/transports/modbus-transport.js` — Modbus 区域读写、错误转换和通用生命周期。
- Create: `main/transports/tcp-transport.js` — TCP 打开连接。
- Create: `main/transports/rtu-transport.js` — RTU 串口打开连接。
- Create: `main/transports/factory.js` — 根据 `transport` 创建传输实例。
- Create: `main/serial-ports.js` — 跨平台串口枚举和稳定输出格式。
- Modify: `main/modbus-service.js` — 保留 facade API，改为委托 Transport。
- Modify: `main/device-manager.js` — 继续按实例创建 Service，并接受 TCP/RTU 配置。
- Modify: `main/index.js` — 注册串口枚举 IPC。
- Modify: `preload.js` — 暴露只读串口枚举 API。
- Modify: `package.json`、`package-lock.json` — 显式声明 `serialport` 运行依赖。
- Create: `test/connection-config.test.js`
- Create: `test/transports.test.js`
- Create: `test/serial-ports.test.js`
- Modify: `test/modbus-service.test.js`
- Modify: `test/device-manager.test.js`

## Task 1: 显式声明串口运行依赖

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 安装与当前 modbus-serial 兼容的串口依赖**

Run:

```bash
npm install serialport@^13.0.0 --save
```

Expected: `package.json` 的 `dependencies` 同时包含 `modbus-serial` 和 `serialport`，命令退出码为 0。

- [ ] **Step 2: 验证原生模块可以加载**

Run:

```bash
node -e "const { SerialPort } = require('serialport'); if (typeof SerialPort.list !== 'function') process.exit(1); console.log('serialport ok')"
```

Expected: 输出 `serialport ok`。

- [ ] **Step 3: 运行原有纯单元测试**

Run:

```bash
npx vitest run test/codec.test.js test/poller.test.js test/device-manager.test.js
```

Expected: 3 个测试文件全部通过。

- [ ] **Step 4: 提交依赖变更**

```bash
git add package.json package-lock.json
git commit -m "build: add serialport runtime dependency"
```

## Task 2: TCP/RTU 配置规范化与校验

**Files:**
- Create: `main/connection-config.js`
- Create: `test/connection-config.test.js`

- [ ] **Step 1: 编写失败测试**

```js
// test/connection-config.test.js
import { describe, it, expect } from 'vitest'
import { normalizeConnectionConfig } from '../main/connection-config.js'

describe('normalizeConnectionConfig', () => {
  it('旧配置缺少 transport 时按 TCP 处理', () => {
    expect(normalizeConnectionConfig({ host: '127.0.0.1', port: 502, unitId: 1 })).toMatchObject({
      transport: 'tcp', host: '127.0.0.1', port: 502, unitId: 1, timeout: 2000,
    })
  })

  it('规范化 RTU 默认参数', () => {
    expect(normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM3', unitId: 1 })).toEqual({
      transport: 'rtu', serialPath: 'COM3', baudRate: 9600, dataBits: 8,
      stopBits: 1, parity: 'none', unitId: 1, timeout: 2000,
    })
  })

  it.each([
    [{ transport: 'tcp', host: '', port: 502, unitId: 1 }, 'IP'],
    [{ transport: 'tcp', host: '127.0.0.1', port: 0, unitId: 1 }, '端口'],
    [{ transport: 'rtu', serialPath: '', unitId: 1 }, '串口'],
    [{ transport: 'rtu', serialPath: 'COM3', parity: 'mark', unitId: 1 }, '校验'],
    [{ transport: 'rtu', serialPath: 'COM3', unitId: 248 }, '从站'],
  ])('拒绝非法配置 %#', (cfg, message) => {
    expect(() => normalizeConnectionConfig(cfg)).toThrow(message)
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run test/connection-config.test.js
```

Expected: FAIL，提示找不到 `main/connection-config.js`。

- [ ] **Step 3: 实现最小配置模块**

```js
// main/connection-config.js
const PARITIES = ['none', 'even', 'odd']

function integer(value, name, min, max, fallback) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}应为 ${min}~${max} 的整数`)
  return n
}

function normalizeConnectionConfig(raw = {}) {
  const transport = raw.transport || 'tcp'
  if (!['tcp', 'rtu'].includes(transport)) throw new Error(`未知通信方式：${transport}`)
  const common = {
    transport,
    unitId: integer(raw.unitId, '从站 ID', 1, 247, 1),
    timeout: integer(raw.timeout, '超时', 100, 60000, 2000),
  }
  if (transport === 'tcp') {
    const host = String(raw.host || '').trim()
    if (!host) throw new Error('请输入设备 IP 或主机名')
    return { transport, host, port: integer(raw.port, '端口', 1, 65535, 502), unitId: common.unitId, timeout: common.timeout }
  }
  const serialPath = String(raw.serialPath || '').trim()
  if (!serialPath) throw new Error('请选择串口')
  const parity = raw.parity || 'none'
  if (!PARITIES.includes(parity)) throw new Error('校验方式仅支持 none、even、odd')
  return {
    transport, serialPath,
    baudRate: integer(raw.baudRate, '波特率', 110, 4000000, 9600),
    dataBits: integer(raw.dataBits, '数据位', 7, 8, 8),
    stopBits: integer(raw.stopBits, '停止位', 1, 2, 1),
    parity, unitId: common.unitId, timeout: common.timeout,
  }
}

module.exports = { normalizeConnectionConfig }
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npx vitest run test/connection-config.test.js`

Expected: 所有测试通过。

- [ ] **Step 5: 提交配置模块**

```bash
git add main/connection-config.js test/connection-config.test.js
git commit -m "feat: validate TCP and RTU connection config"
```

## Task 3: 建立通用 Transport 与 TCP 实现

**Files:**
- Create: `main/transports/modbus-transport.js`
- Create: `main/transports/tcp-transport.js`
- Create: `test/transports.test.js`

- [ ] **Step 1: 编写 TCP Transport 失败测试**

```js
// test/transports.test.js
import { describe, it, expect, vi } from 'vitest'
import TcpTransport from '../main/transports/tcp-transport.js'

function fakeClient() {
  return {
    isOpen: false,
    connectTCP: vi.fn(async () => {}), setID: vi.fn(), setTimeout: vi.fn(),
    readHoldingRegisters: vi.fn(async () => ({ data: [10, 20] })),
    readDiscreteInputs: vi.fn(async () => ({ data: [true, false] })),
    writeRegister: vi.fn(async () => {}), writeRegisters: vi.fn(async () => {}),
    writeCoil: vi.fn(async () => {}), close: vi.fn(cb => cb()),
  }
}

describe('TcpTransport', () => {
  it('连接并复用通用读写能力', async () => {
    const client = fakeClient()
    const transport = new TcpTransport(() => client)
    await transport.connect({ transport: 'tcp', host: '10.0.0.2', port: 1502, unitId: 2, timeout: 3000 })
    expect(client.connectTCP).toHaveBeenCalledWith('10.0.0.2', { port: 1502 })
    expect(client.setID).toHaveBeenCalledWith(2)
    expect(await transport.read('holding', 0, 2)).toEqual([10, 20])
    await transport.write('holding', 5, [7])
    expect(client.writeRegister).toHaveBeenCalledWith(5, 7)
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run test/transports.test.js`

Expected: FAIL，提示找不到 `tcp-transport.js`。

- [ ] **Step 3: 实现共享基类**

```js
// main/transports/modbus-transport.js
const ModbusRTU = require('modbus-serial')

const READERS = {
  coil: { fn: 'readCoils', bit: true }, discrete: { fn: 'readDiscreteInputs', bit: true },
  holding: { fn: 'readHoldingRegisters', bit: false }, input: { fn: 'readInputRegisters', bit: false },
}
const HINTS = { 1: '非法功能码', 2: '非法数据地址', 3: '非法数据值', 4: '设备故障', 6: '设备忙' }

function friendly(err) {
  if (err?.modbusCode) return new Error(`设备返回异常码 ${err.modbusCode}（${HINTS[err.modbusCode] || '未知异常'}）`)
  if (/Timed out/i.test(err?.message || '')) return new Error('请求超时：设备无响应，请检查连接参数和从站 ID')
  if (/Port Not Open/i.test(err?.message || '')) return new Error('连接已断开')
  return err
}

class ModbusTransport {
  constructor(createClient = () => new ModbusRTU()) { this.createClient = createClient; this.client = null; this.params = null }
  get connected() { return this.client?.isOpen === true }
  async connect(params) {
    await this.disconnect(); const client = this.createClient(); await this.open(client, params)
    client.setID(params.unitId); client.setTimeout(params.timeout); this.client = client; this.params = { ...params }
  }
  async reconnect() { if (!this.params) throw new Error('尚未配置过连接参数'); await this.connect(this.params) }
  async disconnect() { if (this.client?.isOpen) await new Promise(resolve => this.client.close(resolve)); this.client = null }
  async read(area, addr, count) {
    const reader = READERS[area]; if (!reader) throw new Error(`未知区域类型: ${area}`)
    try { const res = await this.client[reader.fn](addr, count); return reader.bit ? res.data.slice(0, count).map(v => v ? 1 : 0) : Array.from(res.data) }
    catch (err) { throw friendly(err) }
  }
  async write(area, addr, words) {
    if (area === 'input' || area === 'discrete') throw new Error('该区域为只读，不支持写入')
    try {
      if (area === 'coil') return await this.client.writeCoil(addr, words[0] === 1)
      if (words.length === 1) return await this.client.writeRegister(addr, words[0])
      return await this.client.writeRegisters(addr, words)
    } catch (err) { throw friendly(err) }
  }
}

module.exports = { ModbusTransport, friendly }
```

- [ ] **Step 4: 实现 TCP 子类**

```js
// main/transports/tcp-transport.js
const { ModbusTransport } = require('./modbus-transport')
class TcpTransport extends ModbusTransport {
  open(client, params) { return client.connectTCP(params.host, { port: params.port }) }
}
module.exports = TcpTransport
```

- [ ] **Step 5: 运行 Transport 测试**

Run: `npx vitest run test/transports.test.js`

Expected: PASS。

- [ ] **Step 6: 提交 TCP Transport**

```bash
git add main/transports/modbus-transport.js main/transports/tcp-transport.js test/transports.test.js
git commit -m "refactor: extract common Modbus transport"
```

## Task 4: 实现 RTU Transport 与工厂

**Files:**
- Create: `main/transports/rtu-transport.js`
- Create: `main/transports/factory.js`
- Modify: `test/transports.test.js`

- [ ] **Step 1: 增加 RTU 和工厂失败测试**

```js
// 追加到 test/transports.test.js
import RtuTransport from '../main/transports/rtu-transport.js'
import { createTransport } from '../main/transports/factory.js'

it('RTU 使用完整串口参数打开连接', async () => {
  const client = fakeClient()
  client.connectRTUBuffered = vi.fn(async () => {})
  const transport = new RtuTransport(() => client)
  await transport.connect({ transport: 'rtu', serialPath: 'COM3', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 2000 })
  expect(client.connectRTUBuffered).toHaveBeenCalledWith('COM3', { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' })
})

it('工厂按 transport 创建实现，旧配置创建 TCP', () => {
  expect(createTransport({ transport: 'rtu' })).toBeInstanceOf(RtuTransport)
  expect(createTransport({})).toBeInstanceOf(TcpTransport)
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run test/transports.test.js`

Expected: FAIL，提示缺少 RTU 模块。

- [ ] **Step 3: 实现 RTU 子类和工厂**

```js
// main/transports/rtu-transport.js
const { ModbusTransport } = require('./modbus-transport')
class RtuTransport extends ModbusTransport {
  open(client, p) {
    return client.connectRTUBuffered(p.serialPath, {
      baudRate: p.baudRate, dataBits: p.dataBits, stopBits: p.stopBits, parity: p.parity,
    })
  }
}
module.exports = RtuTransport
```

```js
// main/transports/factory.js
const TcpTransport = require('./tcp-transport')
const RtuTransport = require('./rtu-transport')
function createTransport(config, createClient) {
  return config?.transport === 'rtu' ? new RtuTransport(createClient) : new TcpTransport(createClient)
}
module.exports = { createTransport }
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npx vitest run test/transports.test.js`

Expected: TCP 和 RTU 测试全部通过。

- [ ] **Step 5: 提交 RTU Transport**

```bash
git add main/transports/rtu-transport.js main/transports/factory.js test/transports.test.js
git commit -m "feat: add Modbus RTU transport"
```

## Task 5: 将 ModbusService 迁移为统一 facade

**Files:**
- Modify: `main/modbus-service.js`
- Modify: `test/modbus-service.test.js`

- [ ] **Step 1: 增加 facade 单元测试**

```js
// 追加到 test/modbus-service.test.js，放在真实 TCP beforeAll describe 之外
import { vi } from 'vitest'

it('根据规范化配置创建传输层并保存参数用于重连', async () => {
  const transport = { connect: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(), read: vi.fn(), write: vi.fn(), connected: true }
  const factory = vi.fn(() => transport)
  const service = new ModbusService(factory)
  await service.connect({ transport: 'rtu', serialPath: 'COM3', unitId: 1 })
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({ transport: 'rtu', baudRate: 9600 }))
  await service.reconnect()
  expect(transport.reconnect).toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run test/modbus-service.test.js`

Expected: 新 facade 测试失败，现有 TCP 集成测试仍保持原行为。

- [ ] **Step 3: 用 facade 替换原实现**

```js
// main/modbus-service.js
const { normalizeConnectionConfig } = require('./connection-config')
const { createTransport } = require('./transports/factory')

class ModbusService {
  constructor(factory = createTransport) { this.factory = factory; this.transport = null; this.params = null }
  get connected() { return this.transport?.connected === true }
  async connect(raw) {
    await this.disconnect(); const params = normalizeConnectionConfig(raw)
    const transport = this.factory(params); await transport.connect(params)
    this.transport = transport; this.params = params
  }
  async reconnect() { if (!this.transport || !this.params) throw new Error('尚未配置过连接参数'); return this.transport.reconnect() }
  async disconnect() { if (this.transport) await this.transport.disconnect(); this.transport = null }
  read(area, addr, count) { if (!this.transport) return Promise.reject(new Error('设备未连接')); return this.transport.read(area, addr, count) }
  write(area, addr, words) { if (!this.transport) return Promise.reject(new Error('设备未连接')); return this.transport.write(area, addr, words) }
}

module.exports = ModbusService
```

- [ ] **Step 4: 运行 Service 与轮询回归测试**

Run:

```bash
npx vitest run test/modbus-service.test.js test/poller.test.js test/device-manager.test.js
```

Expected: 全部通过；如沙箱禁止本机 TCP，使用已批准的测试权限运行同一命令。

- [ ] **Step 5: 提交 facade 迁移**

```bash
git add main/modbus-service.js test/modbus-service.test.js
git commit -m "refactor: route Modbus service through transports"
```

## Task 6: 跨平台串口枚举

**Files:**
- Create: `main/serial-ports.js`
- Create: `test/serial-ports.test.js`
- Modify: `main/index.js`
- Modify: `preload.js`

- [ ] **Step 1: 编写串口规范化失败测试**

```js
// test/serial-ports.test.js
import { describe, it, expect, vi } from 'vitest'
import { listSerialPorts } from '../main/serial-ports.js'

describe('listSerialPorts', () => {
  it('返回前端稳定字段并按路径排序', async () => {
    const list = vi.fn().mockResolvedValue([
      { path: '/dev/tty.usbserial-B', manufacturer: 'FTDI', vendorId: '0403', productId: '6001' },
      { path: '/dev/tty.usbserial-A' },
    ])
    expect(await listSerialPorts(list)).toEqual([
      { path: '/dev/tty.usbserial-A', displayName: '/dev/tty.usbserial-A', manufacturer: '', serialNumber: '', vendorId: '', productId: '' },
      { path: '/dev/tty.usbserial-B', displayName: '/dev/tty.usbserial-B · FTDI', manufacturer: 'FTDI', serialNumber: '', vendorId: '0403', productId: '6001' },
    ])
  })

  it('枚举失败返回可理解的中文错误', async () => {
    await expect(listSerialPorts(() => Promise.reject(new Error('native failure')))).rejects.toThrow('串口枚举失败')
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run test/serial-ports.test.js`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现串口枚举服务**

```js
// main/serial-ports.js
const { SerialPort } = require('serialport')
async function listSerialPorts(list = () => SerialPort.list()) {
  try {
    const ports = await list()
    return ports.map(p => ({
      path: p.path,
      displayName: p.manufacturer ? `${p.path} · ${p.manufacturer}` : p.path,
      manufacturer: p.manufacturer || '', serialNumber: p.serialNumber || '',
      vendorId: p.vendorId || '', productId: p.productId || '',
    })).sort((a, b) => a.path.localeCompare(b.path))
  } catch (err) { throw new Error(`串口枚举失败：${err.message}`) }
}
module.exports = { listSerialPorts }
```

- [ ] **Step 4: 增加 IPC 白名单**

在 `main/index.js` 顶部引入并在 `registerIpc()` 中注册：

```js
const { listSerialPorts } = require('./serial-ports')
ipcMain.handle('serial:list', () => listSerialPorts())
```

在 `preload.js` 的 `window.api` 对象中增加：

```js
listSerialPorts: () => ipcRenderer.invoke('serial:list'),
```

- [ ] **Step 5: 运行串口与 IPC 相关测试**

Run:

```bash
npx vitest run test/serial-ports.test.js test/icons.test.js
```

Expected: 全部通过，`preload.js` 仍不暴露任意 IPC 通道。

- [ ] **Step 6: 提交串口枚举**

```bash
git add main/serial-ports.js test/serial-ports.test.js main/index.js preload.js
git commit -m "feat: expose cross-platform serial port listing"
```

## Task 7: DeviceManager 的 TCP/RTU 配置回归

**Files:**
- Modify: `test/device-manager.test.js`

- [ ] **Step 1: 增加 RTU 实例配置传递测试**

```js
// 追加到 test/device-manager.test.js
it('RTU 实例配置完整传递给 Service', async () => {
  const svc = stubService()
  const dm = new DeviceManager(() => svc)
  const cfg = {
    transport: 'rtu', serialPath: 'COM3', baudRate: 9600, dataBits: 8,
    stopBits: 1, parity: 'none', unitId: 1, timeout: 2000,
    interval: 1000, blocks: [{ area: 'holding', addr: 12508, count: 3 }],
  }
  await dm.start('ems1', cfg)
  expect(svc.connect).toHaveBeenCalledWith(cfg)
  await dm.stopAll()
})
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run test/device-manager.test.js`

Expected: PASS；当前实现直接传递 `cfg`，原则上不需要生产代码变更。

- [ ] **Step 3: 运行全部非网络测试**

Run:

```bash
npx vitest run --exclude test/modbus-service.test.js
```

Expected: 除真实 TCP 集成测试外全部通过。

- [ ] **Step 4: 提交回归测试**

```bash
git add test/device-manager.test.js
git commit -m "test: cover RTU device manager config"
```

## Task 8: 全量验证与阶段交付

**Files:**
- Modify: `README.zh.md`
- Modify: `README.md`

- [ ] **Step 1: 增加核心能力说明**

在中英文 README 的开发说明中加入：

```markdown
- 通信核心支持 Modbus-TCP 与 Modbus-RTU。
- RTU 串口参数支持 Windows COM 口和 macOS `/dev/tty.*` 设备。
- 网页调试入口将在下一阶段接入该统一通信核心。
```

- [ ] **Step 2: 运行代码语法检查**

Run:

```bash
node --check main/connection-config.js
node --check main/transports/modbus-transport.js
node --check main/transports/tcp-transport.js
node --check main/transports/rtu-transport.js
node --check main/transports/factory.js
node --check main/serial-ports.js
node --check main/modbus-service.js
```

Expected: 全部退出码为 0，无输出。

- [ ] **Step 3: 运行全量测试**

Run:

```bash
npm test
```

Expected: 原有 77 项测试与新增测试全部通过。测试需要监听或连接本机 TCP 时使用获批权限，不把沙箱 EPERM 视为代码失败。

- [ ] **Step 4: 只读枚举本机串口**

Run:

```bash
node -e "require('./main/serial-ports').listSerialPorts().then(console.log).catch(e => { console.error(e.message); process.exit(1) })"
```

Expected: 输出数组；未插 USB 转换器时允许为空数组，插入后应包含 `/dev/tty.*` 或 `COMx`。

- [ ] **Step 5: 检查差异与工作区**

Run:

```bash
git diff --check
git status --short
```

Expected: 无空白错误，仅显示本阶段预期文件。

- [ ] **Step 6: 提交阶段文档**

```bash
git add README.md README.zh.md
git commit -m "docs: describe unified TCP and RTU core"
```

## 后续计划边界

本计划完成后，再分别编写并执行：

1. `web-debug-service`：HTTP/WebSocket、本地配置、落盘日志、`web-api.js` 和全部页面浏览器适配。
2. `ems-example-and-device-validation`：可导入 EMS 点表、只读真实设备验证、危险写入保护及 Windows 验收。
