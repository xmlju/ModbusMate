// preload.js — IPC 白名单桥接：渲染层只能访问这里显式暴露的 API
const { contextBridge, ipcRenderer } = require('electron')

function unpackSerialPortsResponse(response) {
  if (response?.ok) return response.ports

  const details = response?.error ?? {}
  const error = new Error(details.message || '串口枚举失败')
  if (details.code !== undefined) error.code = details.code
  if (details.causeMessage) error.cause = new Error(details.causeMessage)
  throw error
}

contextBridge.exposeInMainWorld('api', {
  listSerialPorts: () => ipcRenderer.invoke('serial:list').then(unpackSerialPortsResponse),
  connect:          p    => ipcRenderer.invoke('modbus:connect', p),
  disconnect:       ()   => ipcRenderer.invoke('modbus:disconnect'),
  startPoll:        c    => ipcRenderer.invoke('modbus:startPoll', c),
  stopPoll:         ()   => ipcRenderer.invoke('modbus:stopPoll'),
  write:            w    => ipcRenderer.invoke('modbus:write', w),
  rawRequest:       r    => ipcRenderer.invoke('modbus:rawRequest', r),
  loadConfig:       ()   => ipcRenderer.invoke('config:load'),
  saveConfig:       c    => ipcRenderer.invoke('config:save', c),
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

  // 点表导入导出
  exportPoints: p => ipcRenderer.invoke('points:export', p),
  importPoints: () => ipcRenderer.invoke('points:import'),

  // 设备图片
  copyImage: (srcPath) => ipcRenderer.invoke('copy-image', srcPath),
  readImage: (relativePath) => ipcRenderer.invoke('read-image', relativePath),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
})
