// main/ipc-handlers.js — 主进程 IPC 业务处理器（安全注册在 ipc-security.js 统一完成）
const crypto = require('crypto')

function createMainIpcHandlers({
  service,
  poller,
  deviceManager,
  serialListHandler,
  llmService,
  loadConfig,
  saveConfig,
  dialog,
  app,
  getWindow,
  send,
  fs,
  path,
}) {
  return {
    'serial:list': event => serialListHandler(event),

    'modbus:connect': async (_event, params) => {
      await service.connect(params)
      send('modbus:status', { state: 'connected' })
    },

    'modbus:disconnect': async () => {
      poller.stop()
      await service.disconnect()
      send('modbus:status', { state: 'disconnected' })
    },

    'modbus:startPoll': (_event, cfg) => poller.start(cfg),
    'modbus:stopPoll': () => poller.stop(),
    'modbus:write': (_event, { area, addr, words }) =>
      poller.running
        ? poller.write(area, addr, words)
        : service.write(area, addr, words),
    'modbus:rawRequest': (_event, request) => service.rawRequest(request),

    'config:load': () => loadConfig(),
    'config:save': (_event, cfg) => saveConfig(cfg),

    'device:start': (_event, { id, cfg }) => deviceManager.start(id, cfg),
    'device:stop': (_event, id) => deviceManager.stop(id),
    'device:write': (_event, { id, area, addr, words }) =>
      deviceManager.write(id, area, addr, words),
    'device:rawFrame': (_event, { id, frameBytes, timeoutMs }) =>
      deviceManager.rawFrame(id, frameBytes, timeoutMs),

    // LLM 点表生成：未传文件参数时弹系统对话框选文档（Electron 专属路径）
    'llm:extractText': async (_event, params) => {
      let target = params
      if (!target?.filePath && !target?.dataBase64) {
        const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
          filters: [{ name: '设备通讯手册', extensions: ['pdf', 'docx', 'doc', 'txt'] }],
          properties: ['openFile'],
        })
        if (canceled || !filePaths?.[0]) return { ok: false, canceled: true }
        target = { filePath: filePaths[0] }
      }
      return { ok: true, ...(await llmService.extractText(target)) }
    },
    'llm:extractPoints': (_event, params) => llmService.extractPoints(params),
    'llm:testConnection': (_event, params) => llmService.testConnection(params),
    'llm:getQuota': () => llmService.getQuota(),

    'points:export': async (_event, { defaultName, json }) => {
      const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
        defaultPath: defaultName,
        filters: [{ name: 'JSON 点表', extensions: ['json'] }],
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      try {
        fs.writeFileSync(filePath, json, 'utf8')
        return { ok: true, path: filePath }
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },

    'points:import': async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
        filters: [{ name: 'JSON 点表', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (canceled || !filePaths?.[0]) return { ok: false, canceled: true }
      try {
        return {
          ok: true,
          path: filePaths[0],
          content: fs.readFileSync(filePaths[0], 'utf8'),
        }
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },

    'copy-image': async (_event, srcPath) => {
      const imgDir = path.join(app.getPath('userData'), 'images')
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })
      const ext = path.extname(srcPath) || '.png'
      const name = crypto.randomUUID() + ext
      const dest = path.join(imgDir, name)
      fs.copyFileSync(srcPath, dest)
      return 'images/' + name
    },

    'read-image': async (_event, relativePath) => {
      const fullPath = path.join(app.getPath('userData'), relativePath)
      const data = fs.readFileSync(fullPath)
      const ext = path.extname(relativePath).toLowerCase()
      const mime = ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp' ? 'image/webp' : 'image/png'
      return `data:${mime};base64,${data.toString('base64')}`
    },

    'save-image': async (_event, dataUrl) => {
      const imgDir = path.join(app.getPath('userData'), 'images')
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })
      const name = crypto.randomUUID() + '.png'
      const dest = path.join(imgDir, name)
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      fs.writeFileSync(dest, Buffer.from(base64, 'base64'))
      return 'images/' + name
    },
  }
}

module.exports = { createMainIpcHandlers }
