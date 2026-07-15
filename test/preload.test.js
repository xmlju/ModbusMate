import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

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
  it('调用固定通道并返回成功结果中的 ports', async () => {
    const ports = [{ path: 'COM1' }]
    const invoke = vi.fn().mockResolvedValue({ ok: true, ports })
    const api = loadPreloadApi(invoke)

    await expect(api.listSerialPorts()).resolves.toEqual(ports)
    expect(invoke).toHaveBeenCalledWith('serial:list')
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
