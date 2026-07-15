import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const {
  normalizeTransport,
  normalizeConnectionView,
  buildConnectionConfig,
  formatConnectionTarget,
  mergeSerialPortOptions,
  mergeConnectionIntoConfig,
  createSerialPortLoader,
  createExclusiveRunner,
} = require('../renderer/connection-ui.js')

describe('工作台连接配置纯函数', () => {
  it.each([undefined, null, '', 'legacy'])('旧配置 transport=%s 默认使用 TCP', value => {
    expect(normalizeTransport(value)).toBe('tcp')
  })

  it.each(['tcp', 'rtu'])('保留受支持的 transport=%s', transport => {
    expect(normalizeTransport(transport)).toBe(transport)
  })

  it('拒绝未知通信方式，不静默降级', () => {
    expect(() => normalizeTransport('udp')).toThrow('未知通信方式')
  })

  it('旧 TCP 配置补齐 UI 默认值', () => {
    expect(normalizeConnectionView({ host: ' 10.0.0.2 ', port: '1502', unitId: 0 })).toEqual({
      transport: 'tcp', host: '10.0.0.2', port: 1502,
      serialPath: '', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
      unitId: 0, timeout: 2000,
    })
  })

  it('RTU 配置补齐 9600 8N1、ID 1 和 2000ms', () => {
    expect(normalizeConnectionView({ transport: 'rtu', serialPath: ' COM3 ' })).toEqual({
      transport: 'rtu', host: '', port: 502,
      serialPath: 'COM3', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
      unitId: 1, timeout: 2000,
    })
  })

  it('只构建 TCP 和通用字段，并兼容从站 0 与 255', () => {
    for (const unitId of [0, 255]) {
      expect(buildConnectionConfig({
        transport: 'tcp', host: ' 10.0.0.2 ', port: '502', unitId: String(unitId),
        timeout: '3000', serialPath: 'COM3', baudRate: '115200',
      })).toEqual({ transport: 'tcp', host: '10.0.0.2', port: 502, unitId, timeout: 3000 })
    }
  })

  it.each([1, 247])('只构建 RTU 和通用字段，接受边界 ID %s', unitId => {
    expect(buildConnectionConfig({
      transport: 'rtu', serialPath: ' COM3 ', baudRate: '115200', dataBits: '7',
      parity: 'even', stopBits: '2', unitId: String(unitId),
      host: 'should-not-leak', port: '502',
    })).toEqual({
      transport: 'rtu', serialPath: 'COM3', baudRate: 115200, dataBits: 7,
      parity: 'even', stopBits: 2, unitId, timeout: 2000,
    })
  })

  it.each([
    [{ transport: 'tcp', host: '', port: '502', unitId: '1' }, 'TCP 主机地址不能为空'],
    [{ transport: 'tcp', host: 'x', port: '', unitId: '1' }, 'TCP 端口不能为空'],
    [{ transport: 'tcp', host: 'x', port: 'abc', unitId: '1' }, 'TCP 端口必须是整数'],
    [{ transport: 'rtu', serialPath: '', unitId: '1' }, '请选择串口'],
    [{ transport: 'rtu', serialPath: 'COM3', unitId: '0' }, 'RTU 从站地址必须是 1 到 247'],
    [{ transport: 'tcp', host: 'x', port: '502', unitId: '256' }, 'TCP 从站地址必须是 0 到 255'],
    [{ transport: 'tcp', host: 'x', port: '502', unitId: '' }, '从站地址不能为空'],
    [{ transport: 'rtu', serialPath: 'COM3', baudRate: 'bad', unitId: '1' }, '波特率必须是整数'],
    [{ transport: 'tcp', host: 'x', port: '502', unitId: '1', timeout: 'bad' }, '超时时间必须是整数'],
    [{ transport: 'rtu', serialPath: 'COM3', baudRate: '', unitId: '1' }, '波特率不能为空'],
    [{ transport: 'tcp', host: 'x', port: '502', unitId: '1', timeout: '' }, '超时时间不能为空'],
  ])('空值或非法数字返回详细中文错误', (values, message) => {
    expect(() => buildConnectionConfig(values)).toThrow(message)
  })

  it.each([1, 65535])('TCP 接受端口边界 %s', port => {
    expect(buildConnectionConfig({ transport: 'tcp', host: 'localhost', port, unitId: 1 }).port).toBe(port)
  })

  it.each([0, 65536])('TCP 拒绝越界端口 %s', port => {
    expect(() => buildConnectionConfig({ transport: 'tcp', host: 'localhost', port, unitId: 1 }))
      .toThrow('TCP 端口必须是 1 到 65535 之间的整数')
  })

  it('TCP 拒绝小数端口', () => {
    expect(() => buildConnectionConfig({ transport: 'tcp', host: 'localhost', port: 1.5, unitId: 1 }))
      .toThrow('TCP 端口必须是整数')
  })

  it.each([100, 60000])('接受超时边界 %s', timeout => {
    expect(buildConnectionConfig({ transport: 'tcp', host: 'localhost', port: 502, unitId: 1, timeout }).timeout).toBe(timeout)
  })

  it.each([99, 60001])('拒绝越界超时 %s', timeout => {
    expect(() => buildConnectionConfig({ transport: 'tcp', host: 'localhost', port: 502, unitId: 1, timeout }))
      .toThrow('超时时间必须是 100 到 60000 之间的整数')
  })

  it('拒绝小数超时', () => {
    expect(() => buildConnectionConfig({ transport: 'tcp', host: 'localhost', port: 502, unitId: 1, timeout: 100.5 }))
      .toThrow('超时时间必须是整数')
  })

  it.each([110, 230400, 4000000])('RTU 接受合法波特率 %s', baudRate => {
    expect(buildConnectionConfig({ transport: 'rtu', serialPath: 'COM3', baudRate, unitId: 1 }).baudRate).toBe(baudRate)
  })

  it.each([109, 4000001])('RTU 拒绝越界波特率 %s', baudRate => {
    expect(() => buildConnectionConfig({ transport: 'rtu', serialPath: 'COM3', baudRate, unitId: 1 }))
      .toThrow('RTU 波特率必须是 110 到 4000000 之间的整数')
  })

  it('RTU 拒绝小数波特率', () => {
    expect(() => buildConnectionConfig({ transport: 'rtu', serialPath: 'COM3', baudRate: 9600.5, unitId: 1 }))
      .toThrow('波特率必须是整数')
  })

  it.each([
    [{ dataBits: 6 }, 'RTU 数据位只能是 7 或 8'],
    [{ dataBits: 9 }, 'RTU 数据位只能是 7 或 8'],
    [{ stopBits: 0 }, 'RTU 停止位只能是 1 或 2'],
    [{ stopBits: 3 }, 'RTU 停止位只能是 1 或 2'],
    [{ parity: 'mark' }, 'RTU 校验位只能是 none、even 或 odd'],
    [{ parity: '' }, 'RTU 校验位只能是 none、even 或 odd'],
  ])('RTU 拒绝非法串口格式 %#', (overrides, message) => {
    expect(() => buildConnectionConfig({ transport: 'rtu', serialPath: 'COM3', unitId: 1, ...overrides }))
      .toThrow(message)
  })

  it('缺失的可选数值字段使用与主进程一致的默认值', () => {
    expect(buildConnectionConfig({ transport: 'rtu', serialPath: 'COM3', unitId: 1 })).toMatchObject({
      baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, timeout: 2000,
    })
  })

  it('格式化 TCP 与 RTU 目标，奇偶校验映射为 N/E/O', () => {
    expect(formatConnectionTarget({ transport: 'tcp', host: '10.0.0.2', port: 502, unitId: 1 }))
      .toBe('TCP · 10.0.0.2:502 · ID 1')
    expect(formatConnectionTarget({ transport: 'rtu', serialPath: 'COM3', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, unitId: 1 }))
      .toBe('RTU · COM3 · 9600 8N1 · ID 1')
    expect(formatConnectionTarget({ transport: 'rtu', serialPath: 'COM4', baudRate: 19200, dataBits: 7, parity: 'even', stopBits: 2, unitId: 2 }))
      .toBe('RTU · COM4 · 19200 7E2 · ID 2')
    expect(formatConnectionTarget({ transport: 'rtu', parity: 'odd' })).toContain('—O—')
  })

  it('串口稳定去重并保留已拔出的当前选项，不解释恶意厂商文本', () => {
    const manufacturer = '<img src=x onerror=alert(1)>'
    const result = mergeSerialPortOptions('COM9', [
      { path: 'COM3', manufacturer, vendorId: '10C4', productId: 'EA60' },
      { path: 'COM3', manufacturer: 'duplicate' },
      { path: '', manufacturer: 'bad' },
    ])
    expect(result).toEqual([
      { path: 'COM3', manufacturer, vendorId: '10C4', productId: 'EA60', unavailable: false },
      { path: 'COM9', manufacturer: '', vendorId: '', productId: '', unavailable: true },
    ])
    expect(result[0].manufacturer).toBe(manufacturer)
    expect(JSON.stringify(result)).not.toContain('<option')
  })

  it('保存连接参数时保留监控、主题、类型和实例配置', () => {
    const existing = { area: 'holding', addr: 10, count: 20, interval: 500, theme: 'dark', deviceTypes: [{ id: 't' }], deviceInstances: [{ id: 'i' }], host: 'old' }
    expect(mergeConnectionIntoConfig(existing, { transport: 'rtu', serialPath: 'COM3', unitId: 1 }))
      .toEqual({ ...existing, transport: 'rtu', serialPath: 'COM3', unitId: 1 })
  })

  it('串口刷新期间复用同一请求，结束后允许再次刷新', async () => {
    let resolve
    let calls = 0
    const listPorts = () => { calls++; return new Promise(done => { resolve = done }) }
    const loader = createSerialPortLoader(listPorts)
    const first = loader.load()
    const second = loader.load()
    expect(second).toBe(first)
    expect(calls).toBe(1)
    resolve([{ path: 'COM3' }])
    await expect(first).resolves.toEqual([{ path: 'COM3' }])
    const third = loader.load()
    expect(calls).toBe(2)
    resolve([])
    await expect(third).resolves.toEqual([])
  })

  it.each(['连接', '断开'])('%s快速双击只执行一次底层调用', async () => {
    let resolve
    let calls = 0
    const runner = createExclusiveRunner()
    const action = () => { calls++; return new Promise(done => { resolve = done }) }
    const first = runner.run(action)
    const second = runner.run(action)
    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(runner.isRunning()).toBe(true)
    resolve('ok')
    await expect(first).resolves.toBe('ok')
    expect(runner.isRunning()).toBe(false)
  })

  it('连接失败后释放独占状态并允许重试', async () => {
    let calls = 0
    const runner = createExclusiveRunner()
    await expect(runner.run(async () => { calls++; throw new Error('连接失败') })).rejects.toThrow('连接失败')
    await expect(runner.run(async () => { calls++; return '已重试' })).resolves.toBe('已重试')
    expect(calls).toBe(2)
  })
})

describe('工作台连接栏 HTML 契约', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])

  it('关键字段存在且所有 id 唯一', () => {
    for (const id of ['transport', 'tcpFields', 'host', 'port', 'rtuFields', 'serialPath', 'refreshSerialBtn', 'baudRate', 'dataBits', 'parity', 'stopBits', 'unitId', 'timeout']) {
      expect(ids, id).toContain(id)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('波特率使用数字输入，能显示 230400 等合法自定义值', () => {
    expect(html).toMatch(/<input id="baudRate"[^>]*type="number"[^>]*min="110"[^>]*max="4000000"/)
    expect(normalizeConnectionView({ transport: 'rtu', serialPath: 'COM3', baudRate: 230400 }).baudRate).toBe(230400)
  })

  it('连接纯函数脚本位于 web-api 之后、app 之前', () => {
    expect(html.indexOf('web-api.js')).toBeLessThan(html.indexOf('connection-ui.js'))
    expect(html.indexOf('connection-ui.js')).toBeLessThan(html.indexOf('app.js'))
  })

  it('品牌说明同时包含 TCP 和 RTU', () => {
    expect(html).toMatch(/TCP\s*\/\s*RTU/)
  })
})
