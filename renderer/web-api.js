// renderer/web-api.js — 浏览器调试模式的 window.api 兼容桥
(function initWebApi(globalScope) {
  'use strict'

  const RPC_METHODS = Object.freeze({
    listSerialPorts: ['serial:list', 0],
    connect: ['modbus:connect', 1],
    disconnect: ['modbus:disconnect', 0],
    startPoll: ['modbus:startPoll', 1],
    stopPoll: ['modbus:stopPoll', 0],
    write: ['modbus:write', 1],
    loadConfig: ['config:load', 0],
    saveConfig: ['config:save', 1],
    deviceStart: ['device:start', 1],
    deviceStop: ['device:stop', 1],
    deviceWrite: ['device:write', 1],
  })
  const EVENT_METHODS = Object.freeze({
    onData: 'modbus:data',
    onStatus: 'modbus:status',
    onLog: 'modbus:log',
    onDeviceData: 'device:data',
    onDeviceStatus: 'device:status',
    onDeviceLog: 'device:log',
  })
  const MAX_TOKEN_LENGTH = 256
  const MAX_IMPORT_BYTES = 1024 * 1024
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024
  const API_CLOSERS = new WeakMap()

  function parseToken(search) {
    const values = new URLSearchParams(String(search || '')).getAll('token')
    if (values.length !== 1 || !values[0].trim() || values[0].length > MAX_TOKEN_LENGTH) return null
    return values[0]
  }

  function startupError() {
    return new Error('网页调试服务启动地址无效：缺少唯一且有效的 token。请关闭本页，并通过 npm run web 输出的完整地址重新打开。')
  }

  function restoreError(details, fallback) {
    const source = details && typeof details === 'object' ? details : {}
    const error = new Error(source.message || fallback)
    if (source.code !== undefined) error.code = source.code
    if (source.causeMessage) error.cause = new Error(source.causeMessage)
    if (Array.isArray(source.errors)) {
      error.errors = source.errors.map(item => {
        const child = new Error(item?.message || '未知错误')
        if (item?.code !== undefined) child.code = item.code
        return child
      })
    }
    return error
  }

  function abortResponse(controller, reply) {
    try { controller.abort() } catch {}
    try {
      const cancellation = reply?.body?.cancel?.()
      Promise.resolve(cancellation).catch(() => undefined)
    } catch {}
  }

  function safeFileName(value) {
    const leaf = String(value || 'modbusmate-points.json').split(/[\\/]/).at(-1)
    return leaf.replace(/[\u0000-\u001f\u007f]/g, '_').trim() || 'modbusmate-points.json'
  }

  function dataImageBytes(value) {
    const comma = value.indexOf(',')
    const metadata = value.slice(0, comma)
    const payload = value.slice(comma + 1)
    if (/;base64(?:;|$)/i.test(metadata)) {
      const compact = payload.replace(/\s/g, '')
      const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
      return Math.max(0, Math.floor(compact.length * 3 / 4) - padding)
    }
    let decoded
    try { decoded = decodeURIComponent(payload) } catch (cause) {
      throw new Error('图片 data URI 的文本编码无效', { cause })
    }
    return new TextEncoder().encode(decoded).byteLength
  }

  function assertDataImage(value) {
    if (!/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.test(value)) {
      throw new Error('网页模式保存图片只接受 data:image URI')
    }
    if (dataImageBytes(value) > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB 安全上限')
  }

  function defaultPickFile(documentRef, windowRef) {
    let input
    let focusTimer
    let settled = false
    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const cleanup = () => {
      clearTimeout(focusTimer)
      windowRef?.removeEventListener?.('focus', onFocus)
      input?.removeEventListener?.('change', onChange)
      input?.removeEventListener?.('cancel', onCancel)
      input?.remove?.()
    }
    const finish = (file, error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectPromise(error)
      else resolvePromise(file || null)
    }
    const onChange = () => finish(input?.files?.[0])
    const onCancel = () => finish(null)
    const onFocus = () => {
      focusTimer = setTimeout(() => {
        if (!input?.files?.length) finish(null)
      }, 0)
    }

    try {
      input = documentRef.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.style.display = 'none'
      documentRef.body.appendChild(input)
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
      windowRef?.addEventListener?.('focus', onFocus, { once: true })
      input.click()
    } catch (error) {
      finish(null, error)
    }
    return { promise, cancel: () => finish(null) }
  }

  function createInvalidApi() {
    const failAsync0 = () => Promise.reject(startupError())
    const failAsync1 = _value => Promise.reject(startupError())
    const failSubscription = _listener => { throw startupError() }
    const api = {}
    for (const [method, [, arity]] of Object.entries(RPC_METHODS)) {
      api[method] = arity === 0 ? failAsync0 : failAsync1
    }
    for (const method of Object.keys(EVENT_METHODS)) api[method] = failSubscription
    api.exportPoints = failAsync1
    api.importPoints = failAsync0
    api.copyImage = failAsync1
    api.readImage = failAsync1
    api.saveImage = failAsync1
    API_CLOSERS.set(api, () => undefined)
    return api
  }

  function closeWebApi(api) {
    API_CLOSERS.get(api)?.()
  }

  function createWebApi(options = {}) {
    const locationRef = options.location || globalScope?.location || { search: '', origin: '' }
    const token = parseToken(locationRef.search)
    if (!token) return createInvalidApi()

    const fetchRef = options.fetch || globalScope?.fetch?.bind(globalScope)
    const EventSourceRef = options.EventSource || globalScope?.EventSource
    const AbortControllerRef = options.AbortController || globalScope?.AbortController || AbortController
    const documentRef = options.document || globalScope?.document
    const URLRef = options.URL || globalScope?.URL
    const BlobRef = options.Blob || globalScope?.Blob
    const consoleRef = options.console || globalScope?.console || console
    const windowRef = options.window || globalScope
    const TextEncoderRef = options.TextEncoder || globalScope?.TextEncoder
    const timeoutMs = options.timeoutMs ?? 10000
    const sseErrorThrottleMs = options.sseErrorThrottleMs ?? 5000
    const listeners = new Map(Object.values(EVENT_METHODS).map(channel => [channel, new Set()]))
    const activePickers = new Set()
    let closed = false
    let lastSseErrorAt = -Infinity

    async function invoke(channel, args) {
      const controller = new AbortControllerRef()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let reply
      let envelope
      try {
        try {
          reply = await fetchRef(`/api/invoke/${encodeURIComponent(channel)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-ModbusMate-Token': token },
            body: JSON.stringify({ args }),
            signal: controller.signal,
          })
        } catch (cause) {
          if (cause?.name === 'AbortError' || controller.signal.aborted) {
            throw new Error(`本地调试服务请求超时（${timeoutMs}ms），请检查服务是否仍在运行。`, { cause })
          }
          throw new Error('无法连接本地调试服务，请确认 npm run web 仍在运行并从其完整地址打开页面。', { cause })
        }
        const rawContentLength = reply.headers?.get?.('content-length')
        if (rawContentLength !== null && rawContentLength !== undefined) {
          const normalizedLength = String(rawContentLength).trim()
          if (!/^\d+$/.test(normalizedLength) || !Number.isSafeInteger(Number(normalizedLength))) {
            abortResponse(controller, reply)
            throw new Error('本地调试服务响应的 Content-Length 无效。')
          }
          if (Number(normalizedLength) > MAX_RPC_RESPONSE_BYTES) {
            abortResponse(controller, reply)
            throw new Error('本地调试服务响应超过 2 MiB 安全上限。')
          }
        }
        let responseText
        try {
          responseText = await reply.text()
        } catch (cause) {
          if (cause?.name === 'AbortError' || controller.signal.aborted) {
            throw new Error(`本地调试服务请求超时（${timeoutMs}ms），请检查服务是否仍在运行。`, { cause })
          }
          throw new Error(`读取本地调试服务响应失败（HTTP ${reply.status}）。`, { cause })
        }
        if (!TextEncoderRef) throw new Error('当前浏览器缺少 UTF-8 响应长度校验能力。')
        if (new TextEncoderRef().encode(responseText).byteLength > MAX_RPC_RESPONSE_BYTES) {
          abortResponse(controller, reply)
          throw new Error('本地调试服务响应超过 2 MiB 安全上限。')
        }
        try {
          envelope = JSON.parse(responseText)
        } catch (cause) {
          throw new Error(`本地调试服务返回的不是有效 JSON（HTTP ${reply.status}）。`, { cause })
        }
      } finally {
        clearTimeout(timer)
      }
      if (!reply.ok || envelope?.ok !== true) {
        throw restoreError(envelope?.error, reply.ok
          ? '本地调试服务响应格式无效：缺少 ok=true。'
          : `本地调试服务请求失败（HTTP ${reply.status}）。`)
      }
      return envelope.value
    }

    function dispatch(channel, payload) {
      const channelListeners = listeners.get(channel)
      if (!channelListeners) return
      for (const listener of [...channelListeners]) {
        try {
          listener(payload)
        } catch (error) {
          Promise.resolve().then(() => consoleRef.error('网页事件监听器执行失败：', error))
        }
      }
    }

    const source = new EventSourceRef(`/api/events?token=${encodeURIComponent(token)}`)
    source.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message?.channel === 'ready') return
      if (typeof message?.channel === 'string') dispatch(message.channel, message.payload)
    })
    source.addEventListener('error', () => {
      if (closed) return
      const now = Date.now()
      if (now - lastSseErrorAt < sseErrorThrottleMs) return
      lastSseErrorAt = now
      const payload = { level: 'error', message: '网页实时事件连接暂时中断，浏览器正在自动重连。' }
      dispatch('modbus:log', payload)
      dispatch('device:log', payload)
    })

    const api = {}
    for (const [method, [channel, arity]] of Object.entries(RPC_METHODS)) {
      api[method] = arity === 0 ? () => invoke(channel, []) : value => invoke(channel, [value])
    }
    for (const [method, channel] of Object.entries(EVENT_METHODS)) {
      api[method] = listener => {
        if (typeof listener !== 'function') throw new TypeError(`${method} 的监听器必须是函数`)
        const set = listeners.get(channel)
        set.add(listener)
        return () => set.delete(listener)
      }
    }

    api.exportPoints = async payload => {
      const { defaultName, json } = payload || {}
      if (!documentRef || !URLRef?.createObjectURL || !BlobRef) throw new Error('当前浏览器不支持文件导出')
      const blob = new BlobRef([String(json ?? '')], { type: 'application/json;charset=utf-8' })
      const objectUrl = URLRef.createObjectURL(blob)
      let anchor
      try {
        anchor = documentRef.createElement('a')
        anchor.href = objectUrl
        anchor.download = safeFileName(defaultName)
        anchor.style = anchor.style || {}
        anchor.style.display = 'none'
        documentRef.body.appendChild(anchor)
        anchor.click()
        return { ok: true }
      } finally {
        try { anchor?.remove?.() } finally { URLRef.revokeObjectURL(objectUrl) }
      }
    }

    api.importPoints = async () => {
      if (closed) return { ok: false, canceled: true }
      let pickerController
      try {
        pickerController = options.pickFile
          ? { promise: Promise.resolve().then(() => options.pickFile()), cancel: () => undefined }
          : defaultPickFile(documentRef, windowRef)
        activePickers.add(pickerController)
        const file = await pickerController.promise
        if (!file) return { ok: false, canceled: true }
        if (!Number.isFinite(file.size) || file.size > MAX_IMPORT_BYTES) {
          return { ok: false, error: '导入文件超过 1 MiB 安全上限' }
        }
        return { ok: true, content: await file.text() }
      } catch (error) {
        return { ok: false, error: `读取导入文件失败：${error?.message || String(error)}` }
      } finally {
        if (pickerController) activePickers.delete(pickerController)
      }
    }

    api.copyImage = async _srcPath => {
      throw new Error('网页模式不支持复制本地图片，请改用图片 data URI。')
    }
    api.readImage = async sourceValue => {
      const value = String(sourceValue || '')
      if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.test(value)) {
        assertDataImage(value)
        return value
      }
      let parsed
      try { parsed = new URL(value, locationRef.origin) } catch { throw new Error('网页模式只允许 data:image、blob 或同源 HTTP 图片') }
      if (!['blob:', 'http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('网页模式只允许 data:image、blob 或同源 HTTP 图片')
      }
      if (parsed.origin !== locationRef.origin) throw new Error('网页模式拒绝读取非同源图片')
      return value
    }
    api.saveImage = async dataUrl => {
      const value = String(dataUrl || '')
      assertDataImage(value)
      return value
    }
    API_CLOSERS.set(api, () => {
      if (closed) return
      closed = true
      for (const picker of [...activePickers]) picker.cancel()
      activePickers.clear()
      source.close()
      for (const set of listeners.values()) set.clear()
    })
    return api
  }

  function installWebApi(targetWindow, options = {}) {
    if (!targetWindow || targetWindow.api) return targetWindow?.api
    const api = createWebApi({
      window: targetWindow,
      location: targetWindow.location,
      document: targetWindow.document,
      fetch: targetWindow.fetch?.bind(targetWindow),
      EventSource: targetWindow.EventSource,
      AbortController: targetWindow.AbortController,
      URL: targetWindow.URL,
      Blob: targetWindow.Blob,
      console: targetWindow.console,
      ...options,
    })
    targetWindow.api = api
    targetWindow.addEventListener?.('pagehide', () => closeWebApi(api), { once: true })
    return api
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { closeWebApi, createWebApi, installWebApi, parseToken, safeFileName }
  } else if (globalScope) {
    installWebApi(globalScope)
  }
})(typeof window !== 'undefined' ? window : globalThis)
