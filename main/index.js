// main/index.js — 主进程入口（Task 10 会扩充 IPC 与服务接线）
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 940, height: 680, minWidth: 800, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
