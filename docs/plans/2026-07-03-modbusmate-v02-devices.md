# ModbusMate v0.2 实施计划 — 设备模型与多设备采集

> **执行者注意**：按任务顺序执行，每任务独立 git commit；涉及测试的先写测试确认失败再实现（TDD）。
> 规格依据：`docs/specs/2026-07-03-modbusmate-design.md` 第十一章「v0.2 增量设计」。
> 项目现状：v0.1 全部完成（46 测试全绿），激活码已禁用且**不再恢复**。

**Goal:** 设备类型（模板）+ 设备实例 + 多实例并发采集 + 按设备分组的仪表盘；保留 v0.1 调试模式不变。

**约定：**
- 代码注释中文；错误提示详细、面向现场工程师
- 新纯函数文件沿用 `renderer/codec.js` 的 IIFE + `module.exports` 双加载模式
- 不得改动激活相关代码（保持禁用状态）

---

### Task 1: ReadPlan — 点位批量读取规划（TDD，新文件，给全量代码）

**Files:** Create `renderer/read-plan.js`、`test/read-plan.test.js`

**Step 1** 写测试 `test/read-plan.test.js`：

```js
import { describe, it, expect } from 'vitest'
import ReadPlan from '../renderer/read-plan.js'

const { buildReadPlan, pickValues } = ReadPlan

describe('buildReadPlan 点位合并', () => {
  it('同区域点位合并为一个连续块（含间隙）', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 5, words: 2 },
    ])).toEqual([{ area: 'holding', addr: 0, count: 7 }])
  })
  it('不同区域各自成块', () => {
    const plan = buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'coil', addr: 3, words: 1 },
    ])
    expect(plan).toContainEqual({ area: 'holding', addr: 0, count: 1 })
    expect(plan).toContainEqual({ area: 'coil', addr: 3, count: 1 })
  })
  it('跨度超 120 字拆成多块', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 200, words: 1 },
    ])).toEqual([
      { area: 'holding', addr: 0, count: 1 },
      { area: 'holding', addr: 200, count: 1 },
    ])
  })
  it('点位乱序输入也能正确规划', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 10, words: 2 },
      { area: 'holding', addr: 2, words: 1 },
    ])).toEqual([{ area: 'holding', addr: 2, count: 10 }])
  })
})

describe('pickValues 切片提取', () => {
  const blocks = [{ area: 'holding', addr: 2, count: 10, values: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] }]
  it('按点位地址取出寄存器切片', () => {
    expect(pickValues(blocks, { area: 'holding', addr: 5, words: 2 })).toEqual([13, 14])
  })
  it('区域不匹配或越界返回 null', () => {
    expect(pickValues(blocks, { area: 'coil', addr: 5, words: 1 })).toBe(null)
    expect(pickValues(blocks, { area: 'holding', addr: 11, words: 2 })).toBe(null)
  })
})
```

**Step 2** 运行确认失败 → **Step 3** 实现 `renderer/read-plan.js`：

```js
// renderer/read-plan.js — 设备点位 → 批量读取块规划（纯函数，无依赖）
// 浏览器：<script> 引入后使用全局 ReadPlan；Vitest：module.exports 加载
const ReadPlan = (() => {
  const MAX_BLOCK = 120   // 单块寄存器上限（Modbus 单次 125，留余量）

  // points: [{ area, addr, words }] → [{ area, addr, count }]（按区域合并连续块，超限拆块）
  function buildReadPlan(points) {
    const byArea = {}
    for (const p of points) (byArea[p.area] = byArea[p.area] || []).push(p)
    const blocks = []
    for (const area of Object.keys(byArea)) {
      const sorted = [...byArea[area]].sort((a, b) => a.addr - b.addr)
      let start = null, end = null
      for (const p of sorted) {
        const pEnd = p.addr + (p.words || 1) - 1
        if (start === null) { start = p.addr; end = pEnd; continue }
        if (pEnd - start + 1 <= MAX_BLOCK) { end = Math.max(end, pEnd) }
        else { blocks.push({ area, addr: start, count: end - start + 1 }); start = p.addr; end = pEnd }
      }
      if (start !== null) blocks.push({ area, addr: start, count: end - start + 1 })
    }
    return blocks
  }

  // 从读取结果块（含 values）中取出某点位的寄存器切片；未命中返回 null
  function pickValues(blocks, point) {
    const words = point.words || 1
    for (const b of blocks) {
      if (b.area !== point.area) continue
      const off = point.addr - b.addr
      if (off >= 0 && off + words <= b.values.length) return b.values.slice(off, off + words)
    }
    return null
  }

  return { buildReadPlan, pickValues }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = ReadPlan
```

**Step 4** 全绿后 commit：`feat: ReadPlan 点位批量读取规划（TDD）`

---

### Task 2: DeviceManager — 多实例并发采集（TDD，新文件，给全量代码）

**Files:** Create `main/device-manager.js`、`test/device-manager.test.js`

**Step 1** 写测试 `test/device-manager.test.js`：

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import DeviceManager from '../main/device-manager.js'

function stubService(over = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([1, 2, 3]),
    write: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const CFG = { host: '127.0.0.1', port: 8502, unitId: 1, interval: 1000, blocks: [{ area: 'holding', addr: 0, count: 3 }] }

describe('DeviceManager', () => {
  it('start 后按周期推送带实例 id 的数据块', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const onData = vi.fn()
    dm.on('data', onData)
    await dm.start('dev1', CFG)
    await vi.advanceTimersByTimeAsync(2500)
    expect(onData).toHaveBeenCalled()
    const d = onData.mock.calls[0][0]
    expect(d.id).toBe('dev1')
    expect(d.blocks[0].values).toEqual([1, 2, 3])
    await dm.stopAll()
  })

  it('多实例并发独立采集', async () => {
    const svcs = { a: stubService({ read: vi.fn().mockResolvedValue([7]) }), b: stubService({ read: vi.fn().mockResolvedValue([8]) }) }
    let n = 0
    const dm = new DeviceManager(() => (n++ === 0 ? svcs.a : svcs.b))
    const got = {}
    dm.on('data', d => { got[d.id] = d.blocks[0].values })
    await dm.start('a', CFG)
    await dm.start('b', { ...CFG, port: 8503 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(got.a).toEqual([7])
    expect(got.b).toEqual([8])
    await dm.stopAll()
  })

  it('连续 3 次读失败 → offline，重连成功 → connected 并继续采集', async () => {
    const svc = stubService({ read: vi.fn().mockRejectedValue(new Error('Timed out')) })
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(`${s.id}:${s.state}`))
    dm.on('pollError', () => {})
    await dm.start('dev1', { ...CFG, interval: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(states).toContain('dev1:offline')
    svc.read.mockResolvedValue([9])
    await vi.advanceTimersByTimeAsync(6000)
    expect(svc.reconnect).toHaveBeenCalled()
    expect(states.filter(s => s === 'dev1:connected').length).toBeGreaterThanOrEqual(2)
    await dm.stopAll()
  })

  it('stop 断开连接并发出 disconnected', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(s.state))
    await dm.start('dev1', CFG)
    await dm.stop('dev1')
    expect(svc.disconnect).toHaveBeenCalled()
    expect(states).toContain('disconnected')
  })

  it('未启动的实例 write 报错', async () => {
    const dm = new DeviceManager(() => stubService())
    await expect(dm.write('nope', 'holding', 0, [1])).rejects.toThrow('设备未连接')
  })
})
```

**Step 2** 确认失败 → **Step 3** 实现 `main/device-manager.js`：

```js
// main/device-manager.js — 多设备实例并发采集：每实例独立连接 + 轮询 + 断线自动重连
// 事件（均带实例 id）：data { id, blocks } / status { id, state } / pollError { id, message }
// 注意：错误事件命名为 pollError（EventEmitter 的 'error' 无监听会崩进程）
const { EventEmitter } = require('events')
const ModbusService = require('./modbus-service')

const OFFLINE_THRESHOLD = 3     // 连续失败次数判定断线
const RETRY_INTERVAL = 5000     // 重连间隔 ms

class DeviceManager extends EventEmitter {
  // createService 可注入（单测用 stub 替换真实 ModbusService）
  constructor(createService = () => new ModbusService()) {
    super()
    this.createService = createService
    this.instances = new Map()   // id → { service, cfg, timer, retryTimer, busy, failCount }
  }

  // cfg = { host, port, unitId, interval, blocks: [{ area, addr, count }] }
  async start(id, cfg) {
    await this.stop(id)
    const service = this.createService()
    const inst = { service, cfg, timer: null, retryTimer: null, busy: false, failCount: 0 }
    this.instances.set(id, inst)
    await service.connect(cfg)
    this.emit('status', { id, state: 'connected' })
    inst.timer = setInterval(() => this._tick(id), cfg.interval)
    this._tick(id)
  }

  async stop(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    clearInterval(inst.timer)
    clearTimeout(inst.retryTimer)
    this.instances.delete(id)
    try { await inst.service.disconnect() } catch { /* 断开异常不影响停止流程 */ }
    this.emit('status', { id, state: 'disconnected' })
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) await this.stop(id)
  }

  write(id, area, addr, words) {
    const inst = this.instances.get(id)
    if (!inst) return Promise.reject(new Error('设备未连接，无法写入'))
    return inst.service.write(area, addr, words)
  }

  async _tick(id) {
    const inst = this.instances.get(id)
    if (!inst || inst.busy) return
    inst.busy = true
    try {
      const blocks = []
      for (const b of inst.cfg.blocks) {
        blocks.push({ ...b, values: await inst.service.read(b.area, b.addr, b.count) })
      }
      inst.failCount = 0
      this.emit('data', { id, blocks })
    } catch (err) {
      inst.failCount++
      this.emit('pollError', { id, message: err.message })
      if (inst.failCount >= OFFLINE_THRESHOLD) this._goOffline(id)
    } finally {
      inst.busy = false
    }
  }

  _goOffline(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    clearInterval(inst.timer); inst.timer = null
    this.emit('status', { id, state: 'offline' })
    const retry = async () => {
      const cur = this.instances.get(id)
      if (!cur) return   // 已被 stop
      try {
        await cur.service.reconnect()
        cur.failCount = 0
        this.emit('status', { id, state: 'connected' })
        cur.timer = setInterval(() => this._tick(id), cur.cfg.interval)
        this._tick(id)
      } catch {
        cur.retryTimer = setTimeout(retry, RETRY_INTERVAL)
      }
    }
    inst.retryTimer = setTimeout(retry, RETRY_INTERVAL)
  }
}

module.exports = DeviceManager
```

**Step 4** 全部测试（含 v0.1 的 46 个）全绿后 commit：`feat: DeviceManager 多设备实例并发采集（TDD）`

---

### Task 3: 主进程 IPC + preload 追加

**Files:** Modify `main/index.js`、`preload.js`

main/index.js 追加（保持现有代码不动）：

```js
const DeviceManager = require('./device-manager')
const deviceManager = new DeviceManager()

// registerIpc() 内追加：
ipcMain.handle('device:start', (_e, { id, cfg }) => deviceManager.start(id, cfg))
ipcMain.handle('device:stop', (_e, id) => deviceManager.stop(id))
ipcMain.handle('device:write', (_e, { id, area, addr, words }) => deviceManager.write(id, area, addr, words))
deviceManager.on('data', d => send('device:data', d))
deviceManager.on('status', s => send('device:status', s))
deviceManager.on('pollError', e => send('device:log', { level: 'error', id: e.id, message: `读取失败：${e.message}` }))

// 退出前清理（app 'window-all-closed' 或 'before-quit' 中）：
deviceManager.stopAll()
```

preload.js 的 `api` 对象追加：

```js
  deviceStart:  p  => ipcRenderer.invoke('device:start', p),
  deviceStop:   id => ipcRenderer.invoke('device:stop', id),
  deviceWrite:  w  => ipcRenderer.invoke('device:write', w),
  onDeviceData:   fn => ipcRenderer.on('device:data',   (_e, d) => fn(d)),
  onDeviceStatus: fn => ipcRenderer.on('device:status', (_e, s) => fn(s)),
  onDeviceLog:    fn => ipcRenderer.on('device:log',    (_e, l) => fn(l)),
```

Commit：`feat: 设备采集 IPC 接线`

---

### Task 4: 渲染层 — 设备模式 UI

**Files:** Modify `renderer/index.html`、`renderer/style.css`、`renderer/app.js`；Create `renderer/device.js`

本任务不给全量代码（执行者已持有 v0.1 渲染层代码上下文），按以下规格实现，**新逻辑集中在 `renderer/device.js`**，`app.js` 只加模式切换钩子：

**1. 模式切换**
- 顶部（连接栏上方或内嵌）加两个 tab：`调试` / `设备`；调试 tab = v0.1 全部现状（连接栏/监控配置/表格/仪表盘按钮行为不变）
- 设备 tab 显示设备工作区，二者互斥显示；当前模式存 config（重启恢复）

**2. 设备工作区布局**
- 左侧栏（~220px）：实例列表，每项显示 状态灯 + 实例名 + 类型名 + 启/停按钮；底部「+ 添加设备」「管理类型」按钮
- 右侧：按设备分组的仪表盘——每个**已启动**实例一个分组：组头（设备名 + 状态灯 + IP），组内是该类型全部点位的大数字卡片（复用 v0.1 的 .dash-card 样式：名称/大号数值/单位/%进度条/变化闪烁）
- 点位值计算：`ReadPlan.pickValues(blocks, point)` 取寄存器切片 → `Codec.decode(slice, 0, point.type, point.wordOrder)` → `Codec.applyTransform(parsed, point)`；位区域点位直接 ON/OFF
- 设备离线时组头状态灯红 + 组体半透明，恢复自动回绿

**3. 类型管理弹窗**
- 类型列表（增/删/改名）；选中类型编辑点位表：每行 名称/区域▾/地址/类型▾/字序▾/k/b/小数位/单位 + 删除行；「+ 添加点位」
- 校验：名称必填、地址 0~65535、k/b 数字；保存时用 `ReadPlan.buildReadPlan` 预演一次，块数 >8 时提示点位过于分散
- index.html 加对应 modal（沿用 .overlay/.modal-box 样式，表格编辑区可放宽 modal 宽度）

**4. 实例管理弹窗**
- 添加/编辑实例：实例名、类型▾、IP、端口(502)、从站ID(1)、周期▾（复用调试模式的周期选项）
- 删除实例需确认；实例运行中不可编辑连接参数（先停止）

**5. 数据流与持久化**
- 启动实例：由类型点位算 `words`（`Codec.TYPES[type].words`，位区域=1）→ `buildReadPlan` → `api.deviceStart({ id, cfg: { host, port, unitId, interval, blocks } })`
- `onDeviceData` 按 id 更新对应分组卡片；`onDeviceStatus` 更新状态灯；`onDeviceLog` 写入公共日志栏（消息前缀实例名）
- `deviceTypes` / `deviceInstances` / 当前模式 存入 config.json（沿用 config:load/save IPC）；应用启动时恢复列表（实例默认不自动启动）

**6. index.html 脚本引入顺序**：codec.js → read-plan.js → device.js → app.js

完成后 `npm test` 全绿（不新增渲染层测试），commit：`feat: 设备模式 — 类型/实例管理与按设备分组仪表盘`

---

### Task 5: 手动验证清单（执行者跑通模拟环境，GUI 项留给用户）

1. 终端 A：`npm run sim`（8502）；终端 B：`node test/simulator.js 8503`
2. `npm start` → 建类型「电池柜」：点位 电池电量(holding 0, uint16, k=0.1, 单位%)、温度(holding 2, float32 AB, 单位℃)、心跳(holding 10, uint16)
3. 建实例「1号电池柜」(127.0.0.1:8502) 和「2号电池柜」(127.0.0.1:8503)，都启动
4. 仪表盘出现两个设备分组，各三张卡片；两组的「心跳」独立每秒刷新并闪烁；电量 25%（250×0.1）带进度条
5. 杀掉 8503 模拟器 → 2号变红半透明、1号不受影响；重启模拟器 → 2号 5s 内恢复
6. 切「调试」tab → v0.1 全部功能不受影响（连接/监控/写入/公式/原仪表盘）
7. 重启应用 → 类型/实例列表还在，模式记忆正确
8. `npm test` 全绿

**用户验收项**：以上 2–7 由用户在 GUI 复核。

---

### Task 6: 文档更新

- README.md（用户手册）新增「设备监控」章节：类型/实例概念、操作步骤、按设备分组仪表盘说明；「开发参考」项目结构补 device-manager.js / read-plan.js / device.js
- 项目完成报告.md 补 v0.2 交付内容与测试数
- Commit：`docs: v0.2 设备监控文档`
