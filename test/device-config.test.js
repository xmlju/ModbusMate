import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const ReadPlan = require('../renderer/read-plan.js')
const {
  buildDeviceConfig,
  buildInstanceRecord,
  createSessionGuard,
  normalizeInstanceView,
  assertInstanceEditable,
  deleteInstanceSafely,
  commitInstanceList,
  createExclusiveAction,
  createKeyedExclusiveRunner,
  normalizeLoadedDevices,
  getFocusable,
  createDialogKeyController,
  applyRadioSelection,
} = require('../renderer/device-config.js')

const type = {
  id: 'battery',
  points: [
    { area: 'holding', addr: 10, type: 'uint16' },
    { area: 'holding', addr: 11, type: 'float32' },
  ],
}

describe('设备实例连接配置', () => {
  it('构建 RTU 运行配置时保留全部串口参数、周期和读取块', () => {
    expect(buildDeviceConfig({
      transport: 'rtu', serialPath: 'COM3', baudRate: 115200,
      dataBits: 7, parity: 'even', stopBits: 2,
      unitId: 9, timeout: 3500, interval: 500,
    }, type, ReadPlan.buildReadPlan)).toEqual({
      transport: 'rtu', serialPath: 'COM3', baudRate: 115200,
      dataBits: 7, parity: 'even', stopBits: 2,
      unitId: 9, timeout: 3500, interval: 500,
      blocks: [{ area: 'holding', addr: 10, count: 3 }],
    })
  })

  it('旧实例缺少 transport 时构建兼容 TCP 运行配置', () => {
    expect(buildDeviceConfig({
      host: '192.168.1.8', port: 1502, unitId: 0, timeout: 4000, interval: 1000,
    }, type, ReadPlan.buildReadPlan)).toEqual({
      transport: 'tcp', host: '192.168.1.8', port: 1502,
      unitId: 0, timeout: 4000, interval: 1000,
      blocks: [{ area: 'holding', addr: 10, count: 3 }],
    })
  })

  it('保存 TCP 实例仅保留身份、TCP、公用字段和周期', () => {
    expect(buildInstanceRecord({ id: 'dev1', stale: true }, {
      typeId: 'battery', name: ' 1号柜 ', iconIdx: 2, interval: '1000',
      transport: 'tcp', host: ' 10.0.0.8 ', port: '502', unitId: '1', timeout: '2500',
      serialPath: 'COM3', baudRate: '115200', dataBits: '7', parity: 'odd', stopBits: '2',
    })).toEqual({
      id: 'dev1', stale: true, typeId: 'battery', name: '1号柜', iconIdx: 2, interval: 1000,
      transport: 'tcp', host: '10.0.0.8', port: 502, unitId: 1, timeout: 2500,
    })
  })

  it('保存 RTU 实例不夹带旧 TCP 字段', () => {
    expect(buildInstanceRecord({ id: 'dev2', host: 'old', port: 502 }, {
      typeId: 'battery', name: '串口柜', iconIdx: 1, interval: '2000',
      transport: 'rtu', serialPath: ' COM9 ', baudRate: '9600',
      dataBits: '8', parity: 'none', stopBits: '1', unitId: '1', timeout: '2000',
      host: 'should-not-leak', port: '1502',
    })).toEqual({
      id: 'dev2', typeId: 'battery', name: '串口柜', iconIdx: 1, interval: 2000,
      transport: 'rtu', serialPath: 'COM9', baudRate: 9600,
      dataBits: 8, parity: 'none', stopBits: 1, unitId: 1, timeout: 2000,
    })
  })

  it('编辑实例保留未来元数据，同时清理互斥协议字段和污染键', () => {
    const existing = JSON.parse('{"id":"dev3","assetTag":"A-001","custom":{"zone":2},"host":"old","port":502,"serialPath":"COM1","baudRate":4800,"dataBits":7,"parity":"odd","stopBits":2,"__proto__":{"polluted":true},"constructor":"bad","pollution":"bad"}')
    const tcp = buildInstanceRecord(existing, {
      typeId: 'battery', name: 'TCP柜', iconIdx: 4, interval: 500,
      transport: 'tcp', host: '10.0.0.9', port: 1502, unitId: 2, timeout: 3000,
    })
    expect(tcp).toEqual({
      id: 'dev3', assetTag: 'A-001', custom: { zone: 2 }, typeId: 'battery', name: 'TCP柜',
      iconIdx: 4, interval: 500, transport: 'tcp', host: '10.0.0.9', port: 1502, unitId: 2, timeout: 3000,
    })
    expect(Object.getPrototypeOf(tcp)).toBe(Object.prototype)
    expect(tcp).not.toHaveProperty('serialPath')
    expect(tcp).not.toHaveProperty('constructor', 'bad')
    expect(tcp).not.toHaveProperty('pollution')

    const rtu = buildInstanceRecord(tcp, {
      typeId: 'battery', name: 'RTU柜', iconIdx: 5, interval: 1000,
      transport: 'rtu', serialPath: 'COM8', baudRate: 9600, dataBits: 8,
      parity: 'none', stopBits: 1, unitId: 1, timeout: 2000,
    })
    expect(rtu.assetTag).toBe('A-001')
    expect(rtu.custom).toEqual({ zone: 2 })
    expect(rtu).not.toHaveProperty('host')
    expect(rtu).not.toHaveProperty('port')
  })

  it('旧实例视图默认 TCP，新 RTU 视图补齐 9600 8N1/ID1/2000ms', () => {
    expect(normalizeInstanceView({ host: '10.0.0.2', port: 502 }).transport).toBe('tcp')
    expect(normalizeInstanceView({ transport: 'rtu', serialPath: 'COM3' })).toMatchObject({
      transport: 'rtu', serialPath: 'COM3', baudRate: 9600,
      dataBits: 8, parity: 'none', stopBits: 1, unitId: 1, timeout: 2000,
    })
  })

  it('实例名、周期和类型缺失时给出详细中文错误', () => {
    expect(() => buildInstanceRecord({}, { transport: 'tcp', host: 'x', port: 502, unitId: 1, timeout: 2000, typeId: '', name: 'a', interval: 1000 })).toThrow('请选择设备类型')
    expect(() => buildInstanceRecord({}, { transport: 'tcp', host: 'x', port: 502, unitId: 1, timeout: 2000, typeId: 't', name: ' ', interval: 1000 })).toThrow('请输入实例名称')
    expect(() => buildInstanceRecord({}, { transport: 'tcp', host: 'x', port: 502, unitId: 1, timeout: 2000, typeId: 't', name: 'a', interval: 123 })).toThrow('周期值无效')
  })

  it('运行中实例拒绝编辑，停止后允许编辑', () => {
    expect(() => assertInstanceEditable(true)).toThrow('设备正在运行，请先停止设备再编辑连接参数')
    expect(() => assertInstanceEditable(false)).not.toThrow()
  })
})

describe('实例串口刷新会话', () => {
  it('关闭弹窗或打开新实例后，旧请求结果不再属于当前会话', () => {
    const guard = createSessionGuard()
    const first = guard.begin()
    expect(guard.isCurrent(first)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(first)).toBe(false)
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})

describe('删除设备实例', () => {
  it('页面状态为空时仍先停止后端，再执行删除保存', async () => {
    const calls = []
    await deleteInstanceSafely('dev1', async id => { calls.push(`stop:${id}`) }, async () => { calls.push('remove') })
    expect(calls).toEqual(['stop:dev1', 'remove'])
  })

  it.each(['设备未连接', '设备不存在', 'device not found'])('后端返回幂等缺失错误“%s”时仍允许删除', async message => {
    let removed = false
    await expect(deleteInstanceSafely('dev1', async () => { throw new Error(message) }, async () => { removed = true })).resolves.toBeUndefined()
    expect(removed).toBe(true)
  })

  it('停止后端失败时不执行删除，错误继续交给页面提示', async () => {
    const error = new Error('串口关闭失败')
    let removed = false
    await expect(deleteInstanceSafely('dev1', async () => { throw error }, async () => { removed = true })).rejects.toBe(error)
    expect(removed).toBe(false)
  })

  it('停止成功但配置保存失败时保留实例并标记设备已经停止', async () => {
    const error = new Error('磁盘写入失败')
    let stopped = false
    let removed = false
    await expect(deleteInstanceSafely(
      'dev1',
      async () => {},
      async () => { throw error },
      () => { stopped = true },
    )).rejects.toBe(error)
    expect(stopped).toBe(true)
    expect(removed).toBe(false)
    expect(error.deviceStoppedBeforeDelete).toBe(true)
  })
})

describe('实例列表原子事务与独占操作', () => {
  it('持久化成功后才替换内存实例列表', async () => {
    const events = []
    const next = [{ id: 'dev2' }]
    await commitInstanceList(next, async value => { events.push(['save', value]) }, value => { events.push(['apply', value]) })
    expect(events).toEqual([['save', next], ['apply', next]])
  })

  it('持久化失败时不替换内存实例列表', async () => {
    let applied = false
    const error = new Error('保存失败')
    await expect(commitInstanceList([], async () => { throw error }, () => { applied = true })).rejects.toBe(error)
    expect(applied).toBe(false)
  })

  it('实例保存双击复用同一请求，失败后恢复按钮并允许重试', async () => {
    const pendingStates = []
    const controller = createExclusiveAction(pending => pendingStates.push(pending))
    let resolve
    let calls = 0
    const first = controller.run(() => { calls++; return new Promise(done => { resolve = done }) })
    const second = controller.run(() => { calls++; return Promise.resolve() })
    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(controller.isPending()).toBe(true)
    resolve('ok')
    await expect(first).resolves.toBe('ok')
    expect(pendingStates).toEqual([true, false])
    await expect(controller.run(async () => { calls++; throw new Error('重试失败') })).rejects.toThrow('重试失败')
    expect(controller.isPending()).toBe(false)
    expect(calls).toBe(2)
  })

  it('同一实例启停独占，不同实例可以并行', async () => {
    const runner = createKeyedExclusiveRunner()
    let resolveA
    let callsA = 0
    const firstA = runner.run('a', () => { callsA++; return new Promise(done => { resolveA = done }) })
    const secondA = runner.run('a', () => { callsA++; return Promise.resolve() })
    const b = runner.run('b', async () => 'b')
    expect(secondA).toBe(firstA)
    expect(callsA).toBe(1)
    await expect(b).resolves.toBe('b')
    resolveA('a')
    await expect(firstA).resolves.toBe('a')
    expect(runner.isPending('a')).toBe(false)
  })
})

describe('配置加载安全边界', () => {
  it('跳过恶意标识符并规范周期，合法未来字段继续保留', () => {
    const result = normalizeLoadedDevices({
      deviceTypes: [
        { id: 'battery_1', name: '<安全文本>', points: [] },
        { id: 'x" onmouseover="alert(1)', name: '恶意', points: [] },
      ],
      deviceInstances: [
        { id: 'dev-1', typeId: 'battery_1', name: '<img>', host: 'x', port: 502, unitId: 1, interval: 999, assetTag: 'A1' },
        { id: 'x] .owned', typeId: 'battery_1', interval: 1000 },
        { id: 'dev2', typeId: 'bad"type', interval: 1000 },
      ],
    })
    expect(result.types).toEqual([{ id: 'battery_1', name: '<安全文本>', points: [] }])
    expect(result.instances).toEqual([
      { id: 'dev-1', typeId: 'battery_1', name: '<img>', host: 'x', port: 502, unitId: 1, interval: 1000, assetTag: 'A1' },
    ])
    expect(result.warnings).toHaveLength(4)
    expect(result.warnings.every(message => /已跳过|已重置/.test(message))).toBe(true)
  })
})

describe('实例弹窗键盘与单选状态', () => {
  function focusable(name, overrides = {}) {
    return {
      name,
      disabled: false,
      hidden: false,
      tabIndex: 0,
      closest: () => null,
      focus() { active.current = this },
      ...overrides,
    }
  }
  const active = { current: null }

  it('动态过滤 disabled、hidden、隐藏分组和负 tabindex 控件', () => {
    const visible = focusable('visible')
    const container = {
      querySelectorAll: () => [
        visible,
        focusable('disabled', { disabled: true }),
        focusable('hidden', { hidden: true }),
        focusable('group-hidden', { closest: selector => selector === '.hidden, [aria-hidden="true"]' ? {} : null }),
        focusable('negative', { tabIndex: -1 }),
      ],
    }
    expect(getFocusable(container)).toEqual([visible])
  })

  it('Tab 从最后回到第一，Shift+Tab 从第一回到最后', () => {
    const first = focusable('first')
    const middle = focusable('middle')
    const last = focusable('last')
    const controls = [first, middle, last]
    const controller = createDialogKeyController({
      getControls: () => controls,
      getActive: () => active.current,
      onEscape: () => {},
    })
    const forward = { key: 'Tab', shiftKey: false, preventDefault() { this.prevented = true } }
    active.current = last
    controller.handle(forward)
    expect(active.current).toBe(first)
    expect(forward.prevented).toBe(true)

    const backward = { key: 'Tab', shiftKey: true, preventDefault() { this.prevented = true } }
    active.current = first
    controller.handle(backward)
    expect(active.current).toBe(last)
    expect(backward.prevented).toBe(true)
  })

  it('中间 Tab 不拦截，Escape 交给关闭策略', () => {
    const controls = [focusable('first'), focusable('middle'), focusable('last')]
    let escapes = 0
    const controller = createDialogKeyController({
      getControls: () => controls,
      getActive: () => active.current,
      onEscape: () => { escapes++ },
    })
    active.current = controls[1]
    const tab = { key: 'Tab', shiftKey: false, preventDefault() { this.prevented = true } }
    controller.handle(tab)
    expect(tab.prevented).toBeUndefined()
    controller.handle({ key: 'Escape', preventDefault() { this.prevented = true } })
    expect(escapes).toBe(1)
  })

  it('图标单选同步 active、aria-checked 和 roving tabindex', () => {
    const options = Array.from({ length: 3 }, () => ({
      tabIndex: -1,
      attrs: {},
      classList: { active: false, toggle(_name, value) { this.active = value } },
      setAttribute(name, value) { this.attrs[name] = value },
    }))
    applyRadioSelection(options, 1)
    expect(options.map(option => option.classList.active)).toEqual([false, true, false])
    expect(options.map(option => option.attrs['aria-checked'])).toEqual(['false', 'true', 'false'])
    expect(options.map(option => option.tabIndex)).toEqual([-1, 0, -1])
  })
})

describe('设备页面 RTU 静态契约', () => {
  const root = path.join(__dirname, '..')
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  const deviceJs = fs.readFileSync(path.join(root, 'renderer', 'device.js'), 'utf8')
  const appJs = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])

  it('实例弹窗包含唯一的 TCP/RTU 字段且纯模块先于 device.js', () => {
    for (const id of [
      'instTransport', 'instTcpFields', 'instHost', 'instPort', 'instRtuFields',
      'instSerialPath', 'instRefreshSerialBtn', 'instBaudRate', 'instDataBits',
      'instParity', 'instStopBits', 'instUnitId', 'instTimeout', 'instInterval',
    ]) expect(ids, id).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(html.indexOf('device-config.js')).toBeLessThan(html.indexOf('device.js'))
  })

  it('设备页不直接选择底层 TCP/RTU 驱动', () => {
    expect(deviceJs).not.toMatch(/connectTCP|connectRTUBuffered/)
  })

  it('设备页所有连接目标统一通过 formatConnectionTarget 展示', () => {
    expect(deviceJs).toContain('ConnectionUI.formatConnectionTarget')
    expect(appJs).toContain('ConnectionUI.formatConnectionTarget')
    expect(deviceJs).not.toMatch(/inst\.host}\s*:\s*\$\{inst\.port/)
    expect(appJs).not.toMatch(/inst\.host}\s*:\s*\$\{inst\.port/)
  })

  it('实例串口选项通过 textContent 构造，不把设备文本写入 innerHTML', () => {
    expect(deviceJs).toMatch(/option\.textContent\s*=/)
    expect(deviceJs).not.toMatch(/innerHTML\s*=.*manufacturer/)
  })

  it('运行中实例在进入编辑前给出中文停止提示', () => {
    expect(deviceJs).toContain("alert('请先停止设备再编辑')")
    expect(deviceJs).toContain('DeviceConfig.assertInstanceEditable')
  })

  it('删除实例使用真实 deviceStop，且不引用不存在的旧钩子', () => {
    expect(deviceJs).toContain('DeviceConfig.deleteInstanceSafely')
    expect(deviceJs).toContain('window.api.deviceStop')
    expect(deviceJs).not.toContain('_appStopInstance')
  })

  it('不把后端实例 id 直接拼入 querySelector，并对属性值转义', () => {
    expect(deviceJs).not.toMatch(/querySelector\(`[^`]*\$\{s\.id\}/)
    expect(deviceJs).toContain('escapeAttr')
  })

  it('实例变更以候选列表持久化成功后再更新 state', () => {
    expect(deviceJs).toContain('DeviceConfig.commitInstanceList')
    expect(deviceJs).toContain('nextInstances')
  })

  it('实例弹窗具备对话框语义、字段标签和 Escape/焦点管理', () => {
    expect(html).toMatch(/id="instanceModal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="instModalTitle"/)
    for (const id of ['instName', 'instTypeSel', 'instTransport', 'instHost', 'instPort', 'instSerialPath', 'instBaudRate', 'instDataBits', 'instParity', 'instStopBits', 'instUnitId', 'instTimeout', 'instInterval']) {
      expect(html).toContain(`for="${id}"`)
    }
    expect(deviceJs).toContain("event.key === 'Escape'")
    expect(deviceJs).toContain('instancePreviousFocus')
    expect(deviceJs).toContain('createDialogKeyController')
    expect(deviceJs).toContain("removeEventListener('keydown'")
  })

  it('图标选择器使用可聚焦 radio button 和 roving tabindex', () => {
    expect(html).toMatch(/id="iconSelector"[^>]*role="radiogroup"[^>]*aria-label="设备图标"/)
    expect(deviceJs).toContain("document.createElement('button')")
    expect(deviceJs).toContain("button.setAttribute('role', 'radio')")
    expect(deviceJs).toContain('DeviceConfig.applyRadioSelection')
  })

  it('实例保存后会刷新设备调试下拉', () => {
    expect(appJs).toContain('window.populateDeviceDebugSel = populateDeviceDebugSel')
  })
})
