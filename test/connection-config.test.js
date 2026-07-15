import { describe, expect, it } from 'vitest'
import connectionConfig from '../main/connection-config.js'

const { normalizeConnectionConfig } = connectionConfig

describe('normalizeConnectionConfig', () => {
  it('旧配置缺少 transport 时按 TCP 默认值规范化，并移除无关字段', () => {
    expect(normalizeConnectionConfig({ host: ' 192.168.1.10 ', extra: true })).toEqual({
      transport: 'tcp',
      host: '192.168.1.10',
      port: 502,
      unitId: 1,
      timeout: 2000,
    })
  })

  it('RTU 配置使用串口默认参数，并移除无关字段', () => {
    expect(normalizeConnectionConfig({
      transport: 'rtu',
      serialPath: ' /dev/ttyUSB0 ',
      host: 'ignored',
    })).toEqual({
      transport: 'rtu',
      serialPath: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 2000,
    })
  })

  it('TCP host 为空时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ host: '   ' }))
      .toThrow('TCP 主机地址 host 不能为空')
  })

  it('TCP port 超出范围时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ host: '127.0.0.1', port: 65536 }))
      .toThrow('TCP 端口 port 必须是 1 到 65535 之间的整数')
  })

  it('RTU serialPath 为空时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: '  ' }))
      .toThrow('RTU 串口路径 serialPath 不能为空')
  })

  it('RTU parity 非法时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', parity: 'mark' }))
      .toThrow('RTU 校验位 parity 只能是 none、even 或 odd')
  })

  it.each([0, 247, 248, 255])('TCP 从站地址 unitId 为 %s 时合法', (unitId) => {
    expect(normalizeConnectionConfig({ host: '127.0.0.1', unitId }).unitId).toBe(unitId)
  })

  it.each([-1, 256])('TCP 从站地址 unitId 为 %s 时抛出详细中文错误', (unitId) => {
    expect(() => normalizeConnectionConfig({ host: '127.0.0.1', unitId }))
      .toThrow('TCP 从站地址 unitId 必须是 0 到 255 之间的整数')
  })

  it.each([1, 247])('RTU 从站地址 unitId 为 %s 时合法', (unitId) => {
    expect(normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', unitId }).unitId)
      .toBe(unitId)
  })

  it.each([0, 248])('RTU 从站地址 unitId 为 %s 时抛出详细中文错误', (unitId) => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', unitId }))
      .toThrow('RTU 从站地址 unitId 必须是 1 到 247 之间的整数')
  })

  it.each([99, 60001])('timeout 为 %s 时抛出包含“超时”的中文错误', (timeout) => {
    expect(() => normalizeConnectionConfig({ host: '127.0.0.1', timeout }))
      .toThrow(/超时/)
  })

  it('RTU dataBits 为 6 时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', dataBits: 6 }))
      .toThrow('RTU 数据位 dataBits 只能是 7 或 8')
  })

  it('RTU stopBits 为 3 时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', stopBits: 3 }))
      .toThrow('RTU 停止位 stopBits 只能是 1 或 2')
  })

  it.each([109, 4000001])('RTU baudRate 为 %s 时抛出包含“波特率”的中文错误', (baudRate) => {
    expect(() => normalizeConnectionConfig({ transport: 'rtu', serialPath: 'COM1', baudRate }))
      .toThrow(/波特率/)
  })

  it('未知 transport 时抛出详细中文错误', () => {
    expect(() => normalizeConnectionConfig({ transport: 'udp' }))
      .toThrow('未知连接类型 transport：udp，仅支持 tcp 或 rtu')
  })

  it.each([
    ['port', { host: '127.0.0.1', port: true }],
    ['unitId', { host: '127.0.0.1', unitId: true }],
    ['dataBits', { transport: 'rtu', serialPath: 'COM1', dataBits: [7] }],
    ['baudRate', { transport: 'rtu', serialPath: 'COM1', baudRate: [9600] }],
  ])('%s 拒绝可被 Number 隐式转换的畸形类型', (field, raw) => {
    expect(() => normalizeConnectionConfig(raw)).toThrow(field)
  })

  it('TCP 字符串数值被规范化为整数', () => {
    expect(normalizeConnectionConfig({
      transport: 'tcp',
      host: 'localhost',
      port: '1502',
      unitId: '12',
      timeout: '3500',
    })).toEqual({
      transport: 'tcp',
      host: 'localhost',
      port: 1502,
      unitId: 12,
      timeout: 3500,
    })
  })

  it('RTU 字符串数值被规范化为整数', () => {
    expect(normalizeConnectionConfig({
      transport: 'rtu',
      serialPath: 'COM3',
      baudRate: '115200',
      dataBits: '7',
      stopBits: '2',
      parity: 'even',
      unitId: '2',
      timeout: '1000',
    })).toEqual({
      transport: 'rtu',
      serialPath: 'COM3',
      baudRate: 115200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      unitId: 2,
      timeout: 1000,
    })
  })
})
