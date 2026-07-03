// preload.js — IPC 白名单桥接：渲染层只能访问这里显式暴露的 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  connect:          p    => ipcRenderer.invoke('modbus:connect', p),
  disconnect:       ()   => ipcRenderer.invoke('modbus:disconnect'),
  startPoll:        c    => ipcRenderer.invoke('modbus:startPoll', c),
  stopPoll:         ()   => ipcRenderer.invoke('modbus:stopPoll'),
  write:            w    => ipcRenderer.invoke('modbus:write', w),
  loadConfig:       ()   => ipcRenderer.invoke('config:load'),
  saveConfig:       c    => ipcRenderer.invoke('config:save', c),
  activationStatus: () => Promise.resolve(true),
  activationVerify: () => Promise.resolve({ ok: true }),
  onData:   fn => ipcRenderer.on('modbus:data',   (_e, d) => fn(d)),
  onStatus: fn => ipcRenderer.on('modbus:status', (_e, s) => fn(s)),
  onLog:    fn => ipcRenderer.on('modbus:log',    (_e, l) => fn(l)),

  // v0.2 设备采集 API
  deviceStart:  p  => ipcRenderer.invoke('device:start', p),
  deviceStop:   id => ipcRenderer.invoke('device:stop', id),
  deviceWrite:  w  => ipcRenderer.invoke('device:write', w),
  onDeviceData:   fn => ipcRenderer.on('device:data',   (_e, d) => fn(d)),
  onDeviceStatus: fn => ipcRenderer.on('device:status', (_e, s) => fn(s)),
  onDeviceLog:    fn => ipcRenderer.on('device:log',    (_e, l) => fn(l)),
})
