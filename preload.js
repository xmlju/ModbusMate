// preload.js — IPC 白名单桥接（Task 10 会填充 API）
const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('api', {})
