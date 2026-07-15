import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

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
    ...overrides,
  }
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
    transport.client = client

    await expect(transport.read('holding', 12, 1)).resolves.toEqual([321])
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(12, 1)
  })

  it('串口已打开但设置从站 ID 失败时优先 close 并保留原错误', async () => {
    const original = new Error('从站 ID 设置失败')
    const client = createFakeClient({
      setID: vi.fn(() => { throw original }),
      destroy: vi.fn(callback => callback()),
    })
    const transport = new RtuTransport(() => client)

    await expect(transport.connect({
      serialPath: '/dev/fake',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 1000,
    })).rejects.toBe(original)

    expect(client.connectRTUBuffered).toHaveBeenCalledOnce()
    expect(client.isOpen).toBe(false)
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
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
  it('读取保持寄存器并返回普通数组', async () => {
    const data = Uint16Array.from([100, 200])
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockResolvedValue({ data }),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('holding', 10, 2)).resolves.toEqual([100, 200])
    expect(client.readHoldingRegisters).toHaveBeenCalledWith(10, 2)
  })

  it('读取离散输入并转换为 0/1', async () => {
    const client = createFakeClient({
      readDiscreteInputs: vi.fn().mockResolvedValue({ data: [true, false, 2] }),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('discrete', 3, 3)).resolves.toEqual([1, 0, 1])
    expect(client.readDiscreteInputs).toHaveBeenCalledWith(3, 3)
  })

  it('读取线圈时仅返回请求数量的数据', async () => {
    const client = createFakeClient({
      readCoils: vi.fn().mockResolvedValue({ data: [true, false, true] }),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('coil', 0, 2)).resolves.toEqual([1, 0])
  })

  it('读取输入寄存器', async () => {
    const client = createFakeClient({
      readInputRegisters: vi.fn().mockResolvedValue({ data: Uint16Array.from([42]) }),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('input', 5, 1)).resolves.toEqual([42])
    expect(client.readInputRegisters).toHaveBeenCalledWith(5, 1)
  })

  it('拒绝未知读取区域', async () => {
    const transport = new ModbusTransport(() => createFakeClient())

    await expect(transport.read('mystery', 0, 1)).rejects.toThrow('未知区域类型: mystery')
  })

  it('写单个保持寄存器', async () => {
    const client = createFakeClient({ writeRegister: vi.fn().mockResolvedValue({ address: 2 }) })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await transport.write('holding', 2, [1234])

    expect(client.writeRegister).toHaveBeenCalledWith(2, 1234)
  })

  it('写多个保持寄存器', async () => {
    const client = createFakeClient({ writeRegisters: vi.fn().mockResolvedValue({ address: 8 }) })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await transport.write('holding', 8, [10, 20])

    expect(client.writeRegisters).toHaveBeenCalledWith(8, [10, 20])
  })

  it('写线圈时把 1/0 转换为 true/false', async () => {
    const client = createFakeClient({ writeCoil: vi.fn().mockResolvedValue({ address: 6 }) })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await transport.write('coil', 6, [1])
    await transport.write('coil', 7, [0])

    expect(client.writeCoil).toHaveBeenNthCalledWith(1, 6, true)
    expect(client.writeCoil).toHaveBeenNthCalledWith(2, 7, false)
  })

  it.each(['input', 'discrete'])('拒绝写入只读区域 %s', async (area) => {
    const transport = new ModbusTransport(() => createFakeClient())

    await expect(transport.write(area, 0, [1])).rejects.toThrow('该区域为只读，不支持写入')
  })

  it('拒绝未知写入区域且不调用任何设备写方法', async () => {
    const client = createFakeClient()
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('mystery', 0, [1])).rejects.toThrow('未知区域类型: mystery')
    expect(client.writeCoil).not.toHaveBeenCalled()
    expect(client.writeRegister).not.toHaveBeenCalled()
    expect(client.writeRegisters).not.toHaveBeenCalled()
  })
})

describe('ModbusTransport 错误友好化', () => {
  it('导出 friendly 供其他传输实现复用', () => {
    const original = Object.assign(new Error('Timed out'), {
      code: 'ETIMEDOUT',
      address: '192.168.1.8',
    })

    const result = friendly(original)

    expect(result.message).toBe('请求超时：设备无响应，请检查网络和从站ID')
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
    [3, '非法数据值：写入值不被设备接受'],
    [4, '设备故障：从站执行请求时发生不可恢复错误'],
    [6, '设备忙：从站正在处理其他命令，请稍后重试'],
  ])('把异常码 %i 转换为中文提示', async (modbusCode, hint) => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(Object.assign(new Error('Modbus exception'), { modbusCode })),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('holding', 0, 1))
      .rejects.toThrow(`设备返回异常码 ${modbusCode}（${hint}）`)
  })

  it('把 Timed out 转换为中文超时提示', async () => {
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(new Error('Timed out')),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.read('holding', 0, 1))
      .rejects.toThrow('请求超时：设备无响应，请检查网络和从站ID')
  })

  it('把 Port Not Open 转换为中文断开提示', async () => {
    const client = createFakeClient({
      writeRegister: vi.fn().mockRejectedValue(new Error('Port Not Open')),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

    await expect(transport.write('holding', 0, [1])).rejects.toThrow('连接已断开')
  })

  it('保留其他错误对象', async () => {
    const original = new Error('校验失败')
    const client = createFakeClient({
      readHoldingRegisters: vi.fn().mockRejectedValue(original),
    })
    const transport = new ModbusTransport(() => client)
    transport.client = client

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
