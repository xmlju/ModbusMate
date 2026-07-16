import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const { ModbusTransport, friendly } = require('../main/transports/modbus-transport.js')
const TcpTransport = require('../main/transports/tcp-transport.js')
const RtuTransport = require('../main/transports/rtu-transport.js')
const { createTransport } = require('../main/transports/factory.js')

function createFakeClient(overrides = {}) {
  return {
    isOpen: false,
    connectTCP: vi.fn().mockImplementation(function () {
      this.isOpen = true
      return Promise.resolve()
    }),
    connectRTUBuffered: vi.fn().mockImplementation(function () {
      this.isOpen = true
      return Promise.resolve()
    }),
    setID: vi.fn(),
    setTimeout: vi.fn(),
    close: vi.fn().mockImplementation(function (callback) {
      this.isOpen = false
      callback()
    }),
    readCoils: vi.fn(),
    readDiscreteInputs: vi.fn(),
    readHoldingRegisters: vi.fn(),
    readInputRegisters: vi.fn(),
    writeCoil: vi.fn(),
    writeRegister: vi.fn(),
    writeRegisters: vi.fn(),
    writeCoils: vi.fn(),
    ...overrides,
  }
}

function expectNoDriverCall(client) {
  expect(client.readCoils).not.toHaveBeenCalled()
  expect(client.readDiscreteInputs).not.toHaveBeenCalled()
  expect(client.readHoldingRegisters).not.toHaveBeenCalled()
  expect(client.readInputRegisters).not.toHaveBeenCalled()
  expect(client.writeCoil).not.toHaveBeenCalled()
  expect(client.writeRegister).not.toHaveBeenCalled()
  expect(client.writeRegisters).not.toHaveBeenCalled()
  expect(client.writeCoils).not.toHaveBeenCalled()
}

function attachClient(transport, client) {
  client.isOpen = true
  transport.client = client
}

describe('RtuTransport 串口连接', () => {
  it('仅把完整串口参数传给 RTU 驱动', async () => {
    const client = createFakeClient()
    const transport = new RtuTransport(() => client)
    const params = {
      transport: 'rtu',
      serialPath: '/dev/tty.usbserial-001',
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      unitId: 8,
      timeout: 2500,
    }

    await transport.connect(params)

    expect(client.connectRTUBuffered).toHaveBeenCalledWith('/dev/tty.usbserial-001', {
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
    })
    expect(client.setID).toHaveBeenCalledWith(8)
    expect(client.setTimeout).toHaveBeenCalledWith(2500)
  })

  it('继承通用 holding 读取能力', async () => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockResolvedValue({ data: Uint16Array.from([321]) }),
    })
    const transport = new RtuTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('holding', 12, 1)).resolves.toEqual([321])
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(12, 1)
  })

  it('串口已打开但设置从站 ID 失败时先 close，再包装 RTU 中文上下文并保留诊断', async () => {
    const original = Object.assign(new Error('set slave id failed'), { code: 'ESETID' })
    const client = createFakeClient({
      setID: vi.fn(() => { throw original }),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: '/dev/fake',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(client.connectRTUBuffered).toHaveBeenCalledOnce()
    expect(client.isOpen).toBe(false)
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
    expect(result.message).toContain('RTU 串口 /dev/fake 已打开，但设置从站 ID 或超时失败')
    expect(result.message).toContain('set slave id failed')
    expect(result.cause).toBe(original)
    expect(result.code).toBe('ESETID')
  })

  it('串口已打开但设置超时失败时先 close，再包装 RTU 中文上下文', async () => {
    const original = Object.assign(new Error('set timeout failed'), { code: 'ETIMESET' })
    const client = createFakeClient({
      setTimeout: vi.fn(() => { throw original }),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu', serialPath: 'COM7', baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 1000,
    }).catch(err => err)

    expect(client.setID).toHaveBeenCalledWith(1)
    expect(client.close).toHaveBeenCalledOnce()
    expect(result.message).toContain('RTU 串口 COM7 已打开，但设置从站 ID 或超时失败')
    expect(result.message).toContain('set timeout failed')
    expect(result.cause).toBe(original)
    expect(result.code).toBe('ETIMESET')
  })

  it.each([
    ['端口不存在', Object.assign(new Error('No such file or directory'), { code: 'ENOENT' }), /串口 .*不存在或已拔出/],
    ['macOS/Linux 权限不足', Object.assign(new Error('Permission denied'), { code: 'EACCES' }), /串口 .*权限不足/],
    ['权限操作被拒绝', Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }), /串口 .*权限不足/],
    ['端口占用', Object.assign(new Error('Resource busy'), { code: 'EBUSY' }), /串口 .*被其他程序占用/],
    ['Windows 拒绝访问', new Error('Error: Access denied'), /Windows 下通常表示串口被占用或访问被拒绝/],
    ['Windows EACCES 拒绝访问', Object.assign(new Error('Error: Access denied'), { code: 'EACCES' }), /串口 .*权限不足/],
    ['code 优先：EACCES 与不存在消息冲突', Object.assign(new Error('No such file or directory'), { code: 'EACCES' }), /串口 .*权限不足/],
    ['code 优先：EBUSY 与拒绝访问消息冲突', Object.assign(new Error('Access denied'), { code: 'EBUSY' }), /串口 .*被其他程序占用/],
    ['code 优先：ENOENT 与权限消息冲突', Object.assign(new Error('Permission denied'), { code: 'ENOENT' }), /串口 .*不存在或已拔出/],
    ['驱动无法打开', new Error('Cannot open /dev/tty.usbserial-001'), /串口 .*不存在、已拔出或无法打开/],
  ])('连接失败时把%s错误转换为中文并保留诊断信息', async (_label, original, expected) => {
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: '/dev/tty.usbserial-001',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toMatch(expected)
    expect(result.message).toContain('/dev/tty.usbserial-001')
    expect(result.cause).toBe(original)
    if (original.code) expect(result.code).toBe(original.code)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
    expect(transport.client).toBeNull()
  })

  it('其他串口打开失败包含端口和精简原始摘要，并隐藏无关本地路径', async () => {
    const original = Object.assign(
      new Error('driver init failed at /Users/operator/private/config.json'),
      { code: 'EDRIVER' },
    )
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: 'COM7',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain('RTU 串口 COM7 打开失败')
    expect(result.message).toContain('driver init failed')
    expect(result.message).not.toContain('/Users/operator/private/config.json')
    expect(result.cause).toBe(original)
    expect(result.code).toBe('EDRIVER')
  })

  it.each([
    ['POSIX 单段路径', 'driver failed at /tmp', ['/tmp']],
    ['macOS 含空格路径', 'driver failed at /Users/John Doe/private/config.json', ['/Users/John Doe/private/config.json', 'John Doe', 'Doe/private']],
    ['Linux home 路径', 'driver failed at /home/name/project/config.yaml', ['/home/name/project/config.yaml']],
    ['Windows 用户路径', 'driver failed at C:\\Users\\John Doe\\private\\config.json', ['C:\\Users\\John Doe\\private\\config.json', 'John Doe', 'Doe\\private']],
    ['Windows Program Files 路径', 'driver failed at D:\\Program Files\\Vendor\\driver.log', ['D:\\Program Files\\Vendor\\driver.log', 'Program Files']],
  ])('通用打开错误完整隐藏%s但保留普通摘要', async (_label, message, forbiddenParts) => {
    const original = Object.assign(new Error(message), { code: 'EDRIVER' })
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: 'COM7',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain('RTU 串口 COM7 打开失败：driver failed at [本地路径已隐藏]')
    for (const part of forbiddenParts) expect(result.message).not.toContain(part)
  })

  it('路径后有普通错误说明时只隐藏路径，不吞掉后续文本', async () => {
    const original = new Error('driver failed at /tmp failed to initialize; retry after reconnect')
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: 'COM7',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain('driver failed at [本地路径已隐藏] failed to initialize; retry after reconnect')
  })

  it.each([
    ['带分号的路径', 'driver failed at /Users/operator;private/secret.txt', 'driver failed at [本地路径已隐藏]', ['private/secret.txt']],
    ['连接词后的说明', 'driver failed at /tmp and device returned CRC mismatch', 'driver failed at [本地路径已隐藏] and device returned CRC mismatch', []],
    ['通用连接词后的说明', 'driver failed at /tmp and initialization aborted', 'driver failed at [本地路径已隐藏] and initialization aborted', []],
    ['逗号后的说明', 'driver failed at /tmp, CRC mismatch', 'driver failed at [本地路径已隐藏], CRC mismatch', []],
    ['方括号内 POSIX 路径', 'driver failed at [/Users/John Doe/private/config.json], retry', 'driver failed at [[本地路径已隐藏]], retry', ['John Doe', 'private/config.json']],
    ['圆括号内 POSIX 路径', 'driver failed at (/home/name/private/config.yaml) and stopped', 'driver failed at ([本地路径已隐藏]) and stopped', ['/home/name/private/config.yaml']],
    ['引号内 Windows 路径', 'driver failed at "C:\\Program Files\\Vendor\\driver.log", retry', 'driver failed at "[本地路径已隐藏]", retry', ['Program Files', 'Vendor\\driver.log']],
    ['UNC 含空格路径', 'driver failed at \\\\server\\share\\My Folder\\driver.log and initialization aborted', 'driver failed at [本地路径已隐藏] and initialization aborted', ['server\\share', 'My Folder']],
    ['路径段含连接词', 'driver failed at /Users/R and D/private/config.json', 'driver failed at [本地路径已隐藏]', ['R and D', 'D/private']],
    ['方括号内含逗号路径', 'driver failed at [/Users/Last, First/private/file.txt], retry', 'driver failed at [[本地路径已隐藏]], retry', ['Last, First', 'First/private']],
    ['引号内含逗号路径', 'driver failed at "C:\\Users\\Last, First\\private\\file.txt", retry', 'driver failed at "[本地路径已隐藏]", retry', ['Last, First', 'First\\private']],
    ['file URI 本地路径', 'driver failed at file:///Users/Last, First/private/file.txt and initialization aborted', 'driver failed at file://[本地路径已隐藏] and initialization aborted', ['Last, First', 'First/private']],
  ])('路径脱敏边界：%s', async (_label, message, expected, forbiddenParts) => {
    const original = new Error(message)
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu', serialPath: 'COM7', baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain(expected)
    for (const part of forbiddenParts) expect(result.message).not.toContain(part)
  })

  it.each([
    'https://example.com/support and initialization aborted',
    'http://example.com/help, CRC mismatch',
  ])('HTTP(S) URI 不作为本地路径脱敏：%s', async (uriMessage) => {
    const original = new Error(`driver reported ${uriMessage}`)
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu', serialPath: 'COM7', baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain(uriMessage)
    expect(result.message).not.toContain('[本地路径已隐藏]')
  })

  it('直接构造 transport 时防御性单行化带控制字符的 serialPath', async () => {
    const original = Object.assign(new Error('driver initialization failed'), { code: 'EDRIVER' })
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu', serialPath: 'COM7\n伪造日志\0', baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 1000,
    }).catch(err => err)

    expect(result.message).not.toMatch(/[\r\n\0]/)
    expect(result.message).toContain('RTU 串口 COM7�伪造日志� 打开失败')
  })

  it('直接构造 transport 时把 C1 NEL 控制字符替换为单行占位符', async () => {
    const original = new Error('driver initialization failed')
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu', serialPath: `COM7${String.fromCharCode(0x85)}伪造日志`, baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 1000,
    }).catch(err => err)

    expect(result.message).not.toContain(String.fromCharCode(0x85))
    expect(result.message).toContain('RTU 串口 COM7�伪造日志 打开失败')
  })

  it('通用错误摘要允许保留当前串口路径', async () => {
    const original = new Error('driver handshake failed for /dev/ttyUSB0')
    const client = createFakeClient({
      connectRTUBuffered: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    const result = await transport.connect({
      transport: 'rtu',
      serialPath: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    }).catch(err => err)

    expect(result.message).toContain('RTU 串口 /dev/ttyUSB0 打开失败')
    expect(result.message).toContain('driver handshake failed')
  })
})

describe('createTransport 工厂', () => {
  it('为 rtu 配置创建 RtuTransport', () => {
    expect(createTransport({ transport: 'rtu' }, vi.fn())).toBeInstanceOf(RtuTransport)
  })

  it.each([
    [{ transport: 'tcp' }],
    [{}],
    [undefined],
  ])('为 TCP 或旧配置创建 TcpTransport', (config) => {
    expect(createTransport(config, vi.fn())).toBeInstanceOf(TcpTransport)
  })

  it.each([
    null,
    [],
    'tcp',
  ])('拒绝非普通对象配置 %#', (config) => {
    expect(() => createTransport(config, vi.fn()))
      .toThrow('连接配置必须是对象')
  })

  it('拒绝未知通信方式', () => {
    expect(() => createTransport({ transport: 'bluetooth' }, vi.fn()))
      .toThrow('未知通信方式')
  })

  it('把 createClient 注入创建出的实例并可用于连接', async () => {
    const client = createFakeClient()
    const createClient = vi.fn(() => client)
    const transport = createTransport({ transport: 'rtu' }, createClient)

    await transport.connect({
      serialPath: '/dev/fake',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    })

    expect(createClient).toHaveBeenCalledOnce()
    expect(client.connectRTUBuffered).toHaveBeenCalledOnce()
  })
})

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TcpTransport 连接生命周期', () => {
  it('使用 TCP 参数连接并设置从站 ID 与超时', async () => {
    const client = createFakeClient()
    const transport = new TcpTransport(() => client)
    const params = { host: '192.168.1.8', port: 1502, unitId: 7, timeout: 3500 }

    await transport.connect(params)

    expect(client.connectTCP).toHaveBeenCalledWith('192.168.1.8', { port: 1502 })
    expect(client.setID).toHaveBeenCalledWith(7)
    expect(client.setTimeout).toHaveBeenCalledWith(3500)
    expect(transport.connected).toBe(true)
    expect(transport.params).toEqual(params)
    expect(transport.params).not.toBe(params)
  })

  it('reconnect 复用已保存配置并创建新客户端', async () => {
    const first = createFakeClient()
    const second = createFakeClient()
    const createClient = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const transport = new TcpTransport(createClient)
    const params = { host: '127.0.0.1', port: 502, unitId: 1, timeout: 2000 }

    await transport.connect(params)
    await transport.reconnect()

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.connectTCP).toHaveBeenCalledWith('127.0.0.1', { port: 502 })
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('没有历史配置时拒绝重连', async () => {
    const transport = new TcpTransport(() => createFakeClient())

    await expect(transport.reconnect()).rejects.toThrow('尚未配置过连接参数')
  })

  it('disconnect 关闭已打开的客户端并清空引用', async () => {
    const client = createFakeClient({ isOpen: true })
    const transport = new TcpTransport(() => client)
    transport.client = client

    await transport.disconnect()

    expect(client.close).toHaveBeenCalledOnce()
    expect(transport.client).toBeNull()
    expect(transport.connected).toBe(false)
  })

  it('disconnect 不关闭未打开的客户端但仍清空引用', async () => {
    const client = createFakeClient()
    const transport = new TcpTransport(() => client)
    transport.client = client

    await transport.disconnect()

    expect(client.close).not.toHaveBeenCalled()
    expect(transport.client).toBeNull()
  })

  it('连接失败时关闭已打开的临时客户端并保留原错误', async () => {
    const original = Object.assign(new Error('握手失败'), { code: 'ECONNRESET' })
    const client = createFakeClient({
      connectTCP: vi.fn().mockImplementation(function () {
        this.isOpen = true
        return Promise.reject(original)
      }),
    })
    const transport = new TcpTransport(() => client)

    await expect(transport.connect({ host: 'bad-host', port: 502, unitId: 1, timeout: 2000 }))
      .rejects.toBe(original)
    expect(client.close).toHaveBeenCalledOnce()
    expect(transport.client).toBeNull()
  })

  it('连接失败时优先 destroy 未打开的临时客户端并保留原错误', async () => {
    const original = new Error('连接初始化失败')
    const client = createFakeClient({
      isOpen: false,
      connectTCP: vi.fn().mockRejectedValue(original),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new TcpTransport(() => client)

    await expect(transport.connect({ host: 'bad-host', port: 502, unitId: 1, timeout: 2000 }))
      .rejects.toBe(original)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
    expect(transport.client).toBeNull()
  })

  it('串行执行并发 connect，最终仅保留第二个客户端', async () => {
    const firstOpen = createDeferred()
    const firstStarted = createDeferred()
    const first = createFakeClient({
      connectTCP: vi.fn().mockImplementation(async function () {
        firstStarted.resolve()
        await firstOpen.promise
        this.isOpen = true
      }),
    })
    const second = createFakeClient()
    const createClient = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const transport = new TcpTransport(createClient)

    const firstConnect = transport.connect({ host: 'first', port: 502, unitId: 1, timeout: 2000 })
    const secondConnect = transport.connect({ host: 'second', port: 1502, unitId: 2, timeout: 3000 })
    await firstStarted.promise

    expect(createClient).toHaveBeenCalledTimes(1)
    firstOpen.resolve()
    await Promise.all([firstConnect, secondConnect])

    expect(first.close).toHaveBeenCalledOnce()
    expect(first.isOpen).toBe(false)
    expect(second.isOpen).toBe(true)
    expect(transport.client).toBe(second)
    expect(transport.params.host).toBe('second')
  })

  it('connect 后立即 disconnect 时最终保持断开', async () => {
    const openGate = createDeferred()
    const client = createFakeClient({
      connectTCP: vi.fn().mockImplementation(async function () {
        await openGate.promise
        this.isOpen = true
      }),
    })
    const transport = new TcpTransport(() => client)

    const connecting = transport.connect({ host: 'device', port: 502, unitId: 1, timeout: 2000 })
    const disconnecting = transport.disconnect()
    openGate.resolve()
    await Promise.all([connecting, disconnecting])

    expect(client.close).toHaveBeenCalledOnce()
    expect(transport.client).toBeNull()
    expect(transport.connected).toBe(false)
  })

  it('close 回调返回错误时拒绝断开并保留客户端引用', async () => {
    const closeError = new Error('串口关闭失败')
    const client = createFakeClient({
      isOpen: true,
      close: vi.fn(callback => callback(closeError)),
    })
    const transport = new TcpTransport(() => client)
    transport.client = client

    await expect(transport.disconnect()).rejects.toBe(closeError)
    expect(transport.client).toBe(client)
    expect(transport.connected).toBe(true)
  })

  it('close 回调返回 true 时规范化为 Error 并保留客户端引用', async () => {
    const client = createFakeClient({
      isOpen: true,
      close: vi.fn(callback => callback(true)),
    })
    const transport = new TcpTransport(() => client)
    transport.client = client

    const result = await transport.disconnect().catch(err => err)

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('关闭连接失败')
    expect(result.cause).toBe(true)
    expect(transport.client).toBe(client)
  })
})

describe('ModbusTransport 读写', () => {
  it('disconnect 等待在途读取完成后再关闭客户端', async () => {
    const readGate = createDeferred()
    const readStarted = createDeferred()
    const client = createFakeClient({
      isOpen: true,
      readHoldingRegisters: vi.fn().mockImplementation(async () => {
        readStarted.resolve()
        await readGate.promise
        return { data: [123] }
      }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    const reading = transport.read('holding', 0, 1)
    await readStarted.promise
    const disconnecting = transport.disconnect()
    await Promise.resolve()

    expect(client.close).not.toHaveBeenCalled()
    readGate.resolve()
    await expect(reading).resolves.toEqual([123])
    await disconnecting

    expect(client.close).toHaveBeenCalledOnce()
    expect(transport.client).toBeNull()
  })

  it('reconnect 等待在途写入完成后再替换客户端', async () => {
    const writeGate = createDeferred()
    const writeStarted = createDeferred()
    const first = createFakeClient({
      isOpen: true,
      writeRegister: vi.fn().mockImplementation(async () => {
        writeStarted.resolve()
        await writeGate.promise
        return { address: 5 }
      }),
    })
    const second = createFakeClient()
    const transport = new TcpTransport(vi.fn(() => second))
    transport.client = first
    transport.params = { host: 'device', port: 502, unitId: 1, timeout: 2000 }

    const writing = transport.write('holding', 5, [99])
    await writeStarted.promise
    const reconnecting = transport.reconnect()
    await Promise.resolve()

    expect(first.close).not.toHaveBeenCalled()
    expect(second.connectTCP).not.toHaveBeenCalled()
    writeGate.resolve()
    await writing
    await reconnecting

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.connectTCP).toHaveBeenCalledOnce()
    expect(transport.client).toBe(second)
  })

  it('reconnect 新客户端打开期间的读取排队并使用新客户端', async () => {
    const openGate = createDeferred()
    const openStarted = createDeferred()
    const first = createFakeClient({ isOpen: true })
    const second = createFakeClient({
      connectTCP: vi.fn().mockImplementation(async function () {
        openStarted.resolve()
        await openGate.promise
        this.isOpen = true
      }),
      readHoldingRegisters: vi.fn().mockResolvedValue({ data: [456] }),
    })
    const transport = new TcpTransport(vi.fn(() => second))
    transport.client = first
    transport.params = { host: 'device', port: 502, unitId: 1, timeout: 2000 }

    const reconnecting = transport.reconnect()
    await openStarted.promise
    const reading = transport.read('holding', 0, 1)

    expect(first.readHoldingRegisters).not.toHaveBeenCalled()
    expect(second.readHoldingRegisters).not.toHaveBeenCalled()
    openGate.resolve()

    await reconnecting
    await expect(reading).resolves.toEqual([456])
    expect(first.readHoldingRegisters).not.toHaveBeenCalled()
    expect(second.readHoldingRegisters).toHaveBeenCalledWith(0, 1)
  })

  it('单次读取失败不阻塞后续读取', async () => {
    const original = new Error('首次读取失败')
    const firstGate = createDeferred()
    const firstStarted = createDeferred()
    const client = createFakeClient({
      readHoldingRegisters: vi.fn()
        .mockImplementationOnce(async () => {
          firstStarted.resolve()
          await firstGate.promise
          throw original
        })
        .mockResolvedValueOnce({ data: [789] }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    const failedRead = transport.read('holding', 0, 1)
    await firstStarted.promise
    const recoveredRead = transport.read('holding', 1, 1)

    expect(client.readHoldingRegisters).toHaveBeenCalledTimes(1)
    firstGate.resolve()
    await expect(failedRead).rejects.toBe(original)
    await expect(recoveredRead).resolves.toEqual([789])
    expect(client.readHoldingRegisters).toHaveBeenCalledTimes(2)
  })

  it('两个普通读取按调用顺序串行执行', async () => {
    const firstGate = createDeferred()
    const firstStarted = createDeferred()
    const client = createFakeClient({
      readHoldingRegisters: vi.fn()
        .mockImplementationOnce(async () => {
          firstStarted.resolve()
          await firstGate.promise
          return { data: [1] }
        })
        .mockResolvedValueOnce({ data: [2] }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    const firstRead = transport.read('holding', 0, 1)
    await firstStarted.promise
    const secondRead = transport.read('holding', 1, 1)

    expect(client.readHoldingRegisters).toHaveBeenCalledTimes(1)
    firstGate.resolve()
    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([[1], [2]])
    expect(client.readHoldingRegisters).toHaveBeenNthCalledWith(2, 1, 1)
  })

  it('读取保持寄存器并返回普通数组', async () => {
    const data = Uint16Array.from([100, 200])
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockResolvedValue({ data }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('holding', 10, 2)).resolves.toEqual([100, 200])
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(10, 2)
  })

  it('读取离散输入并转换为 0/1', async () => {
    const client = createFakeClient({
      readDiscreteInputs: vi.fn().mockResolvedValue({ data: [true, false, 2] }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('discrete', 3, 3)).resolves.toEqual([1, 0, 1])
    expect(client.readDiscreteInputs).toHaveBeenCalledWith(3, 3)
  })

  it('读取线圈时仅返回请求数量的数据', async () => {
    const client = createFakeClient({
      readCoils: vi.fn().mockResolvedValue({ data: [true, false, true] }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('coil', 0, 2)).resolves.toEqual([1, 0])
  })

  it('读取输入寄存器', async () => {
    const client = createFakeClient({
      readInputRegisters: vi.fn().mockResolvedValue({ data: Uint16Array.from([42]) }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('input', 5, 1)).resolves.toEqual([42])
    expect(client.readInputRegisters).toHaveBeenCalledWith(5, 1)
  })

  it('拒绝未知读取区域', async () => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('mystery', 0, 1)).rejects.toThrow('未知区域类型: mystery')
    expectNoDriverCall(client)
  })

  it.each([
    ['字符串', '0'],
    ['布尔值', true],
    ['NaN', Number.NaN],
    ['小数', 1.5],
    ['负数', -1],
    ['超过上限', 65536],
  ])('读取拒绝非法 addr：%s', async (_label, addr) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('holding', addr, 1))
      .rejects.toThrow('addr 必须是 0..65535 范围内的整数')
    expectNoDriverCall(client)
  })

  it.each([
    ['holding', 0, '1', 'count 必须是整数'],
    ['input', 0, true, 'count 必须是整数'],
    ['holding', 0, Number.NaN, 'count 必须是整数'],
    ['input', 0, 1.5, 'count 必须是整数'],
    ['holding', 0, 0, 'holding 读取 count 必须在 1..125 范围内'],
    ['input', 0, 126, 'input 读取 count 必须在 1..125 范围内'],
    ['coil', 0, 0, 'coil 读取 count 必须在 1..2000 范围内'],
    ['discrete', 0, 2001, 'discrete 读取 count 必须在 1..2000 范围内'],
    ['holding', 65535, 2, 'addr + count - 1 不能超过 65535'],
    ['coil', 65535, 2, 'addr + count - 1 不能超过 65535'],
  ])('读取拒绝非法参数：%s addr=%s count=%s', async (area, addr, count, message) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read(area, addr, count)).rejects.toThrow(message)
    expectNoDriverCall(client)
  })

  it.each([
    ['holding', 65411, 125, 'readHoldingRegisters'],
    ['input', 65411, 125, 'readInputRegisters'],
    ['coil', 63536, 2000, 'readCoils'],
    ['discrete', 63536, 2000, 'readDiscreteInputs'],
  ])('允许 %s 在最大 count 下读取至地址上限', async (area, addr, count, method) => {
    const data = Array(count).fill(area === 'holding' || area === 'input' ? 7 : false)
    const client = createFakeClient({ [method]: vi.fn().mockResolvedValue({ data }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read(area, addr, count)).resolves.toHaveLength(count)
    expect(client[method]).toHaveBeenCalledWith(addr, count)
  })

  it('写单个保持寄存器', async () => {
    const client = createFakeClient({ writeRegister: vi.fn().mockResolvedValue({ address: 2 }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await transport.write('holding', 2, [1234])

    expect(client.writeRegister).toHaveBeenCalledWith(2, 1234)
  })

  it('写多个保持寄存器', async () => {
    const client = createFakeClient({ writeRegisters: vi.fn().mockResolvedValue({ address: 8 }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await transport.write('holding', 8, [10, 20])

    expect(client.writeRegisters).toHaveBeenCalledWith(8, [10, 20])
  })

  it('写线圈时把 1/0 转换为 true/false', async () => {
    const client = createFakeClient({ writeCoil: vi.fn().mockResolvedValue({ address: 6 }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await transport.write('coil', 6, [1])
    await transport.write('coil', 7, [0])

    expect(client.writeCoil).toHaveBeenNthCalledWith(1, 6, true)
    expect(client.writeCoil).toHaveBeenNthCalledWith(2, 7, false)
  })

  it.each([
    ['holding', [10, 20], 'writeRegisters', [8, [10, 20]]],
    ['coil', [1], 'writeCoil', [8, true]],
  ])('写入 %s 时立即快照 words，调用后的突变不影响驱动参数', async (area, words, method, expectedArgs) => {
    const client = createFakeClient({ [method]: vi.fn().mockResolvedValue({ address: 8 }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    const writing = transport.write(area, 8, words)
    words[0] = 70000
    words.length = 124

    await writing

    expect(client[method]).toHaveBeenCalledWith(...expectedArgs)
  })

  it('队列被前置操作阻塞时仍使用调用 write 时的 words 快照', async () => {
    const readGate = createDeferred()
    const readStarted = createDeferred()
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockImplementation(async () => {
        readStarted.resolve()
        await readGate.promise
        return { data: [1] }
      }),
      writeRegisters: vi.fn().mockResolvedValue({ address: 10 }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)
    const words = [11, 22]

    const reading = transport.read('holding', 0, 1)
    await readStarted.promise
    const writing = transport.write('holding', 10, words)
    words[0] = 70000
    words.length = 124

    expect(client.writeRegisters).not.toHaveBeenCalled()
    readGate.resolve()
    await reading
    await writing

    expect(client.writeRegisters).toHaveBeenCalledWith(10, [11, 22])
  })

  it.each([
    ['字符串', '0'],
    ['布尔值', false],
    ['NaN', Number.NaN],
    ['小数', 2.5],
    ['负数', -1],
    ['超过上限', 65536],
  ])('写入拒绝非法 addr：%s', async (_label, addr) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('holding', addr, [1]))
      .rejects.toThrow('addr 必须是 0..65535 范围内的整数')
    expectNoDriverCall(client)
  })

  it.each([
    ['非数组', Uint8Array.from([1])],
    ['空数组', []],
    ['undefined 元素', [undefined]],
    ['数值 2', [2]],
    ['字符串 1', ['1']],
    ['布尔值 true', [true]],
    ['多个元素', [0, 1]],
  ])('线圈写入拒绝非法 words：%s', async (_label, words) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('coil', 0, words))
      .rejects.toThrow('coil words 必须是长度恰好为 1 的数组，元素只能是数值 0 或 1')
    expectNoDriverCall(client)
  })

  it.each([
    ['空数组', []],
    ['TypedArray', Uint16Array.from([1])],
    ['字符串元素', ['1']],
    ['布尔元素', [true]],
    ['负数元素', [-1]],
    ['超过上限元素', [65536]],
    ['小数元素', [1.5]],
    ['超过 123 个元素', Array(124).fill(1)],
  ])('保持寄存器写入拒绝非法 words：%s', async (_label, words) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('holding', 0, words)).rejects.toThrow(/holding words/)
    expectNoDriverCall(client)
  })

  it('保持寄存器写入拒绝地址跨度越界', async () => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('holding', 65535, [1, 2]))
      .rejects.toThrow('addr + words.length - 1 不能超过 65535')
    expectNoDriverCall(client)
  })

  it('允许一次写入 123 个保持寄存器至地址上限', async () => {
    const words = Array.from({ length: 123 }, (_, index) => index)
    const client = createFakeClient({ writeRegisters: vi.fn().mockResolvedValue({ address: 65413 }) })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await transport.write('holding', 65413, words)

    expect(client.writeRegisters).toHaveBeenCalledWith(65413, words)
  })

  it.each([
    ['read', () => ['holding', 0, 1]],
    ['write', () => ['holding', 0, [1]]],
  ])('没有 client 时 %s 明确提示设备未连接', async (method, createArgs) => {
    const transport = new ModbusTransport(() => createFakeClient())

    await expect(transport[method](...createArgs())).rejects.toThrow('设备未连接')
  })

  it.each([
    ['read', () => ['holding', 0, 1]],
    ['write', () => ['holding', 0, [1]]],
  ])('client 已关闭时 %s 明确拒绝且不调用驱动', async (method, createArgs) => {
    const client = createFakeClient({ isOpen: false })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport[method](...createArgs()))
      .rejects.toThrow('设备未连接或连接已断开')
    expectNoDriverCall(client)
  })

  it.each(['input', 'discrete'])('拒绝写入只读区域 %s', async (area) => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write(area, '非法地址', [])).rejects.toThrow('该区域为只读，不支持写入')
    expectNoDriverCall(client)
  })

  it('拒绝未知写入区域且不调用任何设备写方法', async () => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('mystery', 0, [1])).rejects.toThrow('未知区域类型: mystery')
    expectNoDriverCall(client)
  })

  it('构造 FC03 读取请求并返回 TX/RX 十六进制字节', async () => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockResolvedValue({ data: Uint16Array.from([0x007B]) }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.rawRequest({ unitId: 1, functionCode: 3, addr: 0, count: 1 }))
      .resolves.toEqual({
        tx: '01 03 00 00 00 01 84 0A',
        rx: '01 03 02 00 7B F8 67',
      })
    expect(client.setID).toHaveBeenCalledWith(1)
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(0, 1)
  })

  it('构造 FC10 多寄存器写入请求并展示写入回显', async () => {
    const client = createFakeClient({
      writeRegisters: vi.fn().mockResolvedValue({ address: 0x10 }),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.rawRequest({
      unitId: 2, functionCode: 16, addr: 0x10, values: [0x1234, 0x00FF],
    })).resolves.toEqual({
      tx: '02 10 00 10 00 02 04 12 34 00 FF F9 11',
      rx: '02 10 00 10 00 02 40 3E',
    })
    expect(client.writeRegisters).toHaveBeenCalledWith(0x10, [0x1234, 0x00FF])
  })

  it('原始报文构造发送拒绝裸字节和不支持的功能码', async () => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.rawRequest({ bytes: '01 03 00 00 00 01' }))
      .rejects.toThrow('不允许输入裸字节流')
    await expect(transport.rawRequest({ unitId: 1, functionCode: 7, addr: 0, count: 1 }))
      .rejects.toThrow('仅支持功能码')
    expectNoDriverCall(client)
  })

  it('RTU 自由报文直接写串口并按静默窗口收帧，不限制功能码', async () => {
    const port = new EventEmitter()
    port.write = vi.fn((buffer, callback) => {
      callback?.()
      setTimeout(() => port.emit('data', Buffer.from([0x01, 0x55, 0x00])), 1)
    })
    const client = createFakeClient({ _port: port, _onReceive: vi.fn() })
    const transport = new RtuTransport(() => client)
    attachClient(transport, client)
    transport.params = { transport: 'rtu' }

    await expect(transport.rawFrame([0x01, 0x55, 0x00], 100)).resolves.toEqual({
      tx: '01 55 00', rx: '01 55 00',
    })
    expect(port.write).toHaveBeenCalledOnce()
  })

  it('RTU 自由报文超时无字节时返回空 RX，TCP 明确拒绝', async () => {
    const port = new EventEmitter()
    port.write = vi.fn((buffer, callback) => callback?.())
    const rtuClient = createFakeClient({ _port: port, _onReceive: vi.fn() })
    const rtu = new RtuTransport(() => rtuClient)
    attachClient(rtu, rtuClient)
    rtu.params = { transport: 'rtu' }
    await expect(rtu.rawFrame([0x01, 0x55], 5)).resolves.toEqual({ tx: '01 55', rx: '' })

    const tcp = new TcpTransport(() => createFakeClient())
    const tcpClient = createFakeClient({ _port: port, _onReceive: vi.fn() })
    attachClient(tcp, tcpClient)
    tcp.params = { transport: 'tcp' }
    await expect(tcp.rawFrame([0x01, 0x55], 5)).rejects.toThrow('自由报文暂只支持 RTU')
  })
})

describe('ModbusTransport 错误友好化', () => {
  it('导出 friendly 供其他传输实现复用', () => {
    const original = Object.assign(new Error('Timed out'), {
      code: 'ETIMEDOUT',
      address: '192.168.1.8',
    })

    const result = friendly(original)

    expect(result.message).toBe('TCP 请求超时：设备无响应，请检查网络、设备地址、端口和从站 ID')
    expect(result.cause).toBe(original)
    expect(result.code).toBe('ETIMEDOUT')
    expect(result.address).toBe('192.168.1.8')

    const modbusOriginal = Object.assign(new Error('Modbus exception'), {
      code: 'EMODBUS',
      modbusCode: 2,
    })
    const modbusResult = friendly(modbusOriginal)
    expect(modbusResult.cause).toBe(modbusOriginal)
    expect(modbusResult.code).toBe('EMODBUS')
    expect(modbusResult.modbusCode).toBe(2)
  })

  it.each([
    [1, '非法功能码：设备不支持该操作'],
    [2, '非法数据地址：设备不存在该地址，请检查起始地址和数量'],
    [3, '非法数据值：写入值超出范围或格式不被设备接受'],
    [4, '设备故障：从站执行请求时发生不可恢复错误'],
    [5, '设备已确认：正在处理该长耗时命令，请稍后查询结果'],
    [6, '设备忙：从站正在处理其他命令，请稍后重试'],
    // 非标准码（0x0C=12）为厂商自定义，无设备字典时给中性提示，不套具体厂商规则
    [12, '厂商自定义异常码（0x0C）：含义因设备而异，请查阅该设备通讯手册'],
  ])('把异常码 %i 转换为中文提示', async (modbusCode, hint) => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(Object.assign(new Error('Modbus exception'), { modbusCode })),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('holding', 0, 1))
      .rejects.toThrow(`设备返回异常码 ${modbusCode}（${hint}）`)
  })

  it('厂商自定义异常码优先用设备自带的 exceptionHints 字典', async () => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(Object.assign(new Error('Modbus exception'), { modbusCode: 12 })),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)
    // 模拟海索 PCS：设备类型随连接配置下发自己的 0x0C 解释
    transport.params = { exceptionHints: { 12: '设备当前状态不允许该操作：请先切到空闲/关机状态' } }

    await expect(transport.read('holding', 0, 1))
      .rejects.toThrow('设备返回异常码 12（设备当前状态不允许该操作：请先切到空闲/关机状态）')
  })

  it('把 TCP Timed out 转换为网络诊断提示', async () => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(new Error('Timed out')),
    })
    const transport = new TcpTransport(() => client)
    attachClient(transport, client)
    transport.params = { transport: 'tcp' }

    await expect(transport.read('holding', 0, 1))
      .rejects.toThrow('TCP 请求超时：设备无响应，请检查网络、设备地址、端口和从站 ID')
  })

  it.each([
    ['读取', 'readHoldingRegisters', transport => transport.read('holding', 0, 1)],
    ['写入', 'writeRegister', transport => transport.write('holding', 0, [1])],
  ])('RTU %s超时提示完整串口参数排查项且不误导检查网络', async (_label, method, operation) => {
    const client = createFakeClient({
      [method]: vi.fn().mockRejectedValue(Object.assign(new Error('operation timeout'), { code: 'ETIMEDOUT' })),
    })
    const transport = new RtuTransport(() => client)
    attachClient(transport, client)
    transport.params = {
      transport: 'rtu',
      serialPath: 'COM7',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
    }

    const result = await operation(transport).catch(err => err)

    expect(result.message).toContain('RTU 请求超时')
    expect(result.message).toContain('USB/RS485 接线')
    expect(result.message).toContain('A/B 极性')
    expect(result.message).toContain('波特率、数据位、校验位、停止位')
    expect(result.message).toContain('从站 ID')
    expect(result.message).not.toContain('网络')
    expect(result.cause).toBeInstanceOf(Error)
    expect(result.code).toBe('ETIMEDOUT')
  })

  it('把 Port Not Open 转换为中文断开提示', async () => {
    const client = createFakeClient({
      writeRegister: vi.fn().mockRejectedValue(new Error('Port Not Open')),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.write('holding', 0, [1])).rejects.toThrow('连接已断开')
  })

  it('保留其他错误对象', async () => {
    const original = new Error('校验失败')
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(original),
    })
    const transport = new ModbusTransport(() => client)
    attachClient(transport, client)

    await expect(transport.read('holding', 0, 1)).rejects.toBe(original)
  })
})

describe('ModbusTransport 基类', () => {
  it('默认 open 明确提示连接方式未实现', async () => {
    const transport = new ModbusTransport(() => createFakeClient())

    await expect(transport.connect({ unitId: 1, timeout: 2000 }))
      .rejects.toThrow('未实现连接方式')
  })
})
