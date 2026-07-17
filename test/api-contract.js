export const API_KEYS = [
  'listSerialPorts', 'connect', 'disconnect', 'startPoll', 'stopPoll', 'write',
  'loadConfig', 'saveConfig', 'onData', 'onStatus', 'onLog',
  'deviceStart', 'deviceStop', 'deviceWrite', 'onDeviceData', 'onDeviceStatus',
  'onDeviceLog', 'deviceRawFrame', 'rawRequest', 'exportPoints', 'importPoints', 'copyImage', 'readImage', 'saveImage',
  'llmExtractText', 'llmExtractPoints', 'onLlmProgress',
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
  rawRequest: 'modbus:rawRequest',
  loadConfig: 'config:load',
  saveConfig: 'config:save',
  deviceStart: 'device:start',
  deviceStop: 'device:stop',
  deviceWrite: 'device:write',
  deviceRawFrame: 'device:rawFrame',
  llmExtractText: 'llm:extractText',
  llmExtractPoints: 'llm:extractPoints',
}
