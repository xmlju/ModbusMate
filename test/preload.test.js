import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { API_KEYS, API_LENGTHS } from './api-contract.js'

function loadPreloadApi(invoke) {
  let api
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

  vm.runInNewContext(source, {
    Error,
    require(moduleName) {
      if (moduleName !== 'electron') throw new Error(`测试不允许加载模块：${moduleName}`)
      return {
        contextBridge: {
          exposeInMainWorld(name, exposedApi) {
            expect(name).toBe('api')
            api = exposedApi
          },
        },
        ipcRenderer: { invoke, on: vi.fn() },
      }
    },
  }, { filename: 'preload.js' })

  return api
}

describe('preload 串口 API', () => {
  it('暴露页面依赖的完整 keys 与函数签名契约', () => {
    const api = loadPreloadApi(vi.fn())
    expect(Object.keys(api).sort()).toEqual([...API_KEYS].sort())
    for (const [method, length] of Object.entries(API_LENGTHS)) {
      expect(api[method].length, method).toBe(length)
    }
  })
  it('调用固定通道并返回成功结果中的 ports', async () => {
    const ports = [{ path: 'COM1' }]
    const invoke = vi.fn().mockResolvedValue({ ok: true, ports })
    const api = loadPreloadApi(invoke)

    await expect(api.listSerialPorts()).resolves.toEqual(ports)
    expect(invoke).toHaveBeenCalledWith('serial:list')
  })

  it('rawRequest 通过固定 IPC 通道发送构造请求参数', async () => {
    const invoke = vi.fn().mockResolvedValue({ tx: '01 03', rx: '01 03' })
    const api = loadPreloadApi(invoke)
    const payload = { unitId: 1, functionCode: 3, addr: 0, count: 1 }

    await expect(api.rawRequest(payload)).resolves.toEqual({ tx: '01 03', rx: '01 03' })
    expect(invoke).toHaveBeenCalledWith('modbus:rawRequest', payload)
  })

  it('恢复失败结果中的 Error message、code 和 cause', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        message: '串口枚举失败：permission denied',
        code: 'EACCES',
        causeMessage: 'permission denied',
      },
    })
    const api = loadPreloadApi(invoke)

    let error
    try {
      await api.listSerialPorts()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('串口枚举失败：permission denied')
    expect(error.code).toBe('EACCES')
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toBe('permission denied')
  })
})
