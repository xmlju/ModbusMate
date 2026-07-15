import { describe, expect, it, vi } from 'vitest'

const { createConfigStore } = require('../main/config-store')

function createIo({ content, readError, writeError, renameError } = {}) {
  const files = new Map()
  if (content !== undefined) files.set('/data/config.json', content)

  return {
    files,
    existsSync: vi.fn(file => files.has(file)),
    readFileSync: vi.fn((file, encoding) => {
      if (readError) throw readError
      expect(encoding).toBe('utf8')
      return files.get(file)
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((file, value, encoding) => {
      if (writeError) throw writeError
      expect(encoding).toBe('utf8')
      files.set(file, value)
    }),
    renameSync: vi.fn((from, to) => {
      if (renameError) throw renameError
      files.set(to, files.get(from))
      files.delete(from)
    }),
    unlinkSync: vi.fn(file => files.delete(file)),
  }
}

describe('独立配置存储', () => {
  it('配置不存在时返回空对象', () => {
    const io = createIo()

    expect(createConfigStore('/data/config.json', io).load()).toEqual({})
    expect(io.readFileSync).not.toHaveBeenCalled()
  })

  it('用 UTF-8 读取 JSON 对象', () => {
    const io = createIo({ content: '{"transport":"rtu","serialPath":"COM3"}' })

    expect(createConfigStore('/data/config.json', io).load()).toEqual({
      transport: 'rtu',
      serialPath: 'COM3',
    })
    expect(io.readFileSync).toHaveBeenCalledWith('/data/config.json', 'utf8')
  })

  it.each([
    ['损坏 JSON', '{bad'],
    ['非对象 JSON', '[1,2]'],
    ['null', 'null'],
  ])('%s 给出带文件位置的中文错误并保留 cause', (_name, content) => {
    const io = createIo({ content })

    let error
    try { createConfigStore('/data/config.json', io).load() } catch (caught) { error = caught }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('配置文件解析失败：/data/config.json')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('递归创建目录并通过同目录临时文件原子保存 UTF-8 JSON', () => {
    const io = createIo()
    const store = createConfigStore('/data/nested/config.json', io)

    expect(store.save({ transport: 'rtu', points: [{ addr: 1 }] })).toEqual({ ok: true })

    expect(io.mkdirSync).toHaveBeenCalledWith('/data/nested', { recursive: true })
    const [tempFile, written, encoding] = io.writeFileSync.mock.calls[0]
    expect(tempFile).toMatch(/^\/data\/nested\/\.config\.json\..+\.tmp$/)
    expect(JSON.parse(written)).toEqual({ transport: 'rtu', points: [{ addr: 1 }] })
    expect(encoding).toBe('utf8')
    expect(io.renameSync).toHaveBeenCalledWith(tempFile, '/data/nested/config.json')
  })

  it.each([
    ['数组', []],
    ['null', null],
    ['自定义原型对象', Object.create({ inherited: true })],
    ['污染键', JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')],
  ])('拒绝保存%s', (_name, config) => {
    const io = createIo()

    expect(() => createConfigStore('/data/config.json', io).save(config))
      .toThrow('配置保存失败：/data/config.json')
    expect(io.writeFileSync).not.toHaveBeenCalled()
  })

  it.each([
    ['写入', { writeError: Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }) }],
    ['替换', { renameError: Object.assign(new Error('文件被占用'), { code: 'EBUSY' }) }],
  ])('%s失败时清理临时文件并保留详细原因', (_name, errors) => {
    const io = createIo(errors)
    let error

    try { createConfigStore('/data/config.json', io).save({ unitId: 1 }) } catch (caught) { error = caught }

    expect(error.message).toContain('配置保存失败：/data/config.json')
    expect(error.cause).toBe(Object.values(errors)[0])
    expect(io.unlinkSync).toHaveBeenCalledTimes(1)
    expect(io.unlinkSync.mock.calls[0][0]).toMatch(/^\/data\/\.config\.json\..+\.tmp$/)
  })
})
