export const API_KEYS = [
  'listSerialPorts', 'connect', 'disconnect', 'startPoll', 'stopPoll', 'write',
  'loadConfig', 'saveConfig', 'onData', 'onStatus', 'onLog',
  'deviceStart', 'deviceStop', 'deviceWrite', 'onDeviceData', 'onDeviceStatus',
  'onDeviceLog', 'exportPoints', 'importPoints', 'copyImage', 'readImage', 'saveImage',
]

export const API_LENGTHS = Object.fromEntries(API_KEYS.map(key => [
  key,
  ['listSerialPorts', 'disconnect', 'stopPoll', 'loadConfig', 'importPoints'].includes(key) ? 0 : 1,
]))

export const RPC_CHANNELS = {
  listSerialPorts: 'serial:list',
  connect: 'modbus:connect',
  disconnect: 'modbus:disconnect',
  startPoll: 'modbus:startPoll',
  stopPoll: 'modbus:stopPoll',
  write: 'modbus:write',
  loadConfig: 'config:load',
  saveConfig: 'config:save',
  deviceStart: 'device:start',
  deviceStop: 'device:stop',
  deviceWrite: 'device:write',
}
