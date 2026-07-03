import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import ModbusService from '../main/modbus-service.js'
import { createSimulator } from './simulator.js'

let sim, svc

beforeAll(async () => {
  sim = createSimulator(8502)
  svc = new ModbusService()
  await svc.connect({ host: '127.0.0.1', port: 8502, unitId: 1 })
})

afterAll(async () => {
  await svc.disconnect()
  await sim.close()
})

describe('ModbusService 读', () => {
  it('FC03 读保持寄存器', async () => {
    const v = await svc.read('holding', 0, 2)
    expect(v[0]).toBe(250)
  })
  it('FC04 读输入寄存器', async () => {
    expect(await svc.read('input', 0, 2)).toEqual([1000, 1001])
  })
  it('FC02 读离散输入（返回 0/1）', async () => {
    expect(await svc.read('discrete', 0, 2)).toEqual([1, 0])
  })
})

describe('ModbusService 写', () => {
  it('FC06 写单寄存器后可读回', async () => {
    await svc.write('holding', 5, [1234])
    expect((await svc.read('holding', 5, 1))[0]).toBe(1234)
  })
  it('FC05 写线圈后可读回', async () => {
    await svc.write('coil', 3, [1])
    expect((await svc.read('coil', 3, 1))[0]).toBe(1)
  })
  it('FC16 写两个寄存器（32 位值）', async () => {
    await svc.write('holding', 20, [0x41CC, 0xCCCD])
    expect(await svc.read('holding', 20, 2)).toEqual([0x41CC, 0xCCCD])
  })
  it('只读区域写入抛错', async () => {
    await expect(svc.write('input', 0, [1])).rejects.toThrow('只读')
  })
})
