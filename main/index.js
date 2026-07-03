// main/index.js — 主进程入口：窗口、IPC 接线、配置持久化、崩溃日志
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const ModbusService = require('./modbus-service')
const Poller = require('./poller')
const { Activation } = require('./activation')

const service = new ModbusService()
const poller = new Poller(service)
let activation = null
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
  ipcMain.handle('activation:status', () => activation.isActivated())
  ipcMain.handle('activation:verify', (_e, code) => activation.activate(code))

  poller.on('data', d => send('modbus:data', d))
  poller.on('pollError', msg => send('modbus:log', { level: 'error', message: `读取失败：${msg}` }))
  poller.on('offline', () => send('modbus:status', { state: 'offline' }))
  poller.on('online', () => send('modbus:status', { state: 'connected' }))
}

app.whenReady().then(() => {
  activation = new Activation(app.getPath('userData'))
  registerIpc()
  createWindow()
}).catch(err => { console.error(err); app.quit() })

// macOS 惯例：关窗不退出，点 Dock 图标重开窗口；其他平台关窗即退出
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (win === null && activation) createWindow() })
