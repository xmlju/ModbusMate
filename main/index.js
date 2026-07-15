// main/index.js — 主进程入口：窗口、IPC 接线、配置持久化、崩溃日志
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')
const ModbusService = require('./modbus-service')
const Poller = require('./poller')
const DeviceManager = require('./device-manager')
const { listSerialPorts } = require('./serial-ports')
const { createSerialListHandler } = require('./serial-ipc')
const { createMainIpcHandlers } = require('./ipc-handlers')
const { registerTrustedIpcHandlers } = require('./ipc-security')

const service = new ModbusService()
const poller = new Poller(service)
const deviceManager = new DeviceManager()
let win = null
const appEntryUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href
const serialListHandler = createSerialListHandler({
  listPorts: listSerialPorts,
  // 所有通道由统一注册器完成可信主 frame 校验，此处只负责结果序列化。
  isTrustedEvent: () => true,
})

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
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== appEntryUrl) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL(appEntryUrl)
  win.on('closed', () => { win = null })
}

function send(channel, payload) { win?.webContents.send(channel, payload) }

function registerIpc() {
  const handlers = createMainIpcHandlers({
    service,
    poller,
    deviceManager,
    serialListHandler,
    loadConfig,
    saveConfig,
    dialog,
    app,
    getWindow: () => win,
    send,
    fs,
    path,
  })
  registerTrustedIpcHandlers({
    ipcMain,
    handlers,
    getWindow: () => win,
    expectedUrl: appEntryUrl,
  })

  deviceManager.on('data', d => send('device:data', d))
  deviceManager.on('status', s => send('device:status', s))
  deviceManager.on('pollError', e => send('device:log', { level: 'error', id: e.id, message: `读取失败：${e.message}` }))

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
