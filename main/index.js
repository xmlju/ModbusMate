// main/index.js — 主进程入口：窗口、IPC 接线、配置持久化、崩溃日志
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const ModbusService = require('./modbus-service')
const Poller = require('./poller')
const DeviceManager = require('./device-manager')
const { createSerialListHandler } = require('./serial-ipc')

const service = new ModbusService()
const poller = new Poller(service)
const deviceManager = new DeviceManager()
const serialListHandler = createSerialListHandler()
let win = null

// ── 崩溃级错误落盘，便于远程排查用户问题 ──
process.on('uncaughtException', err => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] ${err.stack}\n`)
  } catch { /* 日志写入失败不再抛出 */ }
})

// ── 配置持久化（连接参数 + 监控配置）──
const configFile = () => path.join(app.getPath('userData'), 'config.json')
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch { return {} } }
function saveConfig(cfg) { fs.writeFileSync(configFile(), JSON.stringify(cfg)) }

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 680, minWidth: 800, minHeight: 560,
    // 安全基线显式写出，避免后续改动时被无意放宽
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.on('closed', () => { win = null })
}

function send(channel, payload) { win?.webContents.send(channel, payload) }

function registerIpc() {
  ipcMain.handle('serial:list', serialListHandler)
  ipcMain.handle('modbus:connect', async (_e, params) => {
    await service.connect(params)
    send('modbus:status', { state: 'connected' })
  })
  ipcMain.handle('modbus:disconnect', async () => {
    poller.stop()
    await service.disconnect()
    send('modbus:status', { state: 'disconnected' })
  })
  ipcMain.handle('modbus:startPoll', (_e, cfg) => poller.start(cfg))
  ipcMain.handle('modbus:stopPoll', () => poller.stop())
  ipcMain.handle('modbus:write', (_e, { area, addr, words }) =>
    poller.running ? poller.write(area, addr, words) : service.write(area, addr, words))
  ipcMain.handle('config:load', () => loadConfig())
  ipcMain.handle('config:save', (_e, cfg) => saveConfig(cfg))

  // v0.2 设备采集 IPC
  ipcMain.handle('device:start', (_e, { id, cfg }) => deviceManager.start(id, cfg))
  ipcMain.handle('device:stop', (_e, id) => deviceManager.stop(id))
  ipcMain.handle('device:write', (_e, { id, area, addr, words }) => deviceManager.write(id, area, addr, words))
  deviceManager.on('data', d => send('device:data', d))
  deviceManager.on('status', s => send('device:status', s))
  deviceManager.on('pollError', e => send('device:log', { level: 'error', id: e.id, message: `读取失败：${e.message}` }))

  // ── 点表导入导出（文件对话框须在主进程） ──
  ipcMain.handle('points:export', async (_e, { defaultName, json }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'JSON 点表', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try { fs.writeFileSync(filePath, json, 'utf8'); return { ok: true, path: filePath } }
    catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('points:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'JSON 点表', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || !filePaths?.[0]) return { ok: false, canceled: true }
    try { return { ok: true, path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf8') } }
    catch (e) { return { ok: false, error: e.message } }
  })

  // 设备图片
  ipcMain.handle('copy-image', async (event, srcPath) => {
    const { copyFileSync, mkdirSync, existsSync } = require('fs')
    const crypto = require('crypto')
    const imgDir = path.join(app.getPath('userData'), 'images')
    if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true })
    const ext = path.extname(srcPath) || '.png'
    const name = crypto.randomUUID() + ext
    const dest = path.join(imgDir, name)
    copyFileSync(srcPath, dest)
    return 'images/' + name
  })

  ipcMain.handle('read-image', async (event, relativePath) => {
    const fullPath = path.join(app.getPath('userData'), relativePath)
    const data = fs.readFileSync(fullPath)
    const ext = path.extname(relativePath).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  })

  ipcMain.handle('save-image', async (event, dataUrl) => {
    // dataUrl 格式: data:image/png;base64,...
    const crypto = require('crypto')
    const imgDir = path.join(app.getPath('userData'), 'images')
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })
    const name = crypto.randomUUID() + '.png'
    const dest = path.join(imgDir, name)
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    fs.writeFileSync(dest, Buffer.from(base64, 'base64'))
    return 'images/' + name
  })

  poller.on('data', d => send('modbus:data', d))
  poller.on('pollError', msg => send('modbus:log', { level: 'error', message: `读取失败：${msg}` }))
  poller.on('offline', () => send('modbus:status', { state: 'offline' }))
  poller.on('online', () => send('modbus:status', { state: 'connected' }))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
}).catch(err => { console.error(err); app.quit() })

// macOS 惯例：关窗不退出，点 Dock 图标重开窗口；其他平台关窗即退出
app.on('window-all-closed', () => { deviceManager.stopAll(); if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (win === null) createWindow() })
