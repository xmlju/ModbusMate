import { describe, it, expect } from 'vitest'
const fs = require('fs')
const path = require('path')
const { listSerialPorts } = require('../main/serial-ports')

describe('listSerialPorts', () => {
  it('映射稳定字段，补齐空字段并按 path 排序', async () => {
    const source = [
      { path: '/dev/ttyUSB9', manufacturer: undefined, extra: 'ignore' },
      { path: '/dev/ttyUSB1', serialNumber: 'SN-1', vendorId: '10C4', productId: 'EA60' },
    ]

    await expect(listSerialPorts(async () => source)).resolves.toEqual([
      {
        path: '/dev/ttyUSB1',
        displayName: '/dev/ttyUSB1',
        manufacturer: '',
        serialNumber: 'SN-1',
        vendorId: '10C4',
        productId: 'EA60',
      },
      {
        path: '/dev/ttyUSB9',
        displayName: '/dev/ttyUSB9',
        manufacturer: '',
        serialNumber: '',
        vendorId: '',
        productId: '',
      },
    ])
  })

  it('displayName 包含厂商名称', async () => {
    const [port] = await listSerialPorts(async () => [
      { path: 'COM3', manufacturer: 'Acme' },
    ])

    expect(port.displayName).toBe('COM3 · Acme')
  })

  it('过滤缺少有效 path 的异常条目', async () => {
    const ports = await listSerialPorts(async () => [
      null,
      {},
      { path: '' },
      { path: '   ' },
      { path: 42 },
      { path: 'COM5' },
    ])

    expect(ports.map(port => port.path)).toEqual(['COM5'])
  })

  it('不修改枚举器返回的原对象和数组顺序', async () => {
    const first = { path: 'COM9', manufacturer: 'Maker' }
    const second = { path: 'COM1' }
    const source = [first, second]
    const snapshot = JSON.parse(JSON.stringify(source))

    await listSerialPorts(async () => source)

    expect(source).toEqual(snapshot)
    expect(source[0]).toBe(first)
    expect(source[1]).toBe(second)
  })

  it('枚举失败时抛出中文错误并保留 cause 和 code', async () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    let error
    try {
      await listSerialPorts(async () => { throw cause })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('串口枚举失败：permission denied')
    expect(error.cause).toBe(cause)
    expect(error.code).toBe('EACCES')
  })
})

describe('串口 IPC 契约', () => {
  it('主进程与 preload 使用固定 serial:list 通道', () => {
    const root = path.join(__dirname, '..')
    const main = fs.readFileSync(path.join(root, 'main', 'index.js'), 'utf8')
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')

    expect(main).toContain("ipcMain.handle('serial:list', () => listSerialPorts())")
    expect(preload).toContain("listSerialPorts: () => ipcRenderer.invoke('serial:list')")
  })
})
