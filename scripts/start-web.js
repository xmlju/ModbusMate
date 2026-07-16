#!/usr/bin/env node
// scripts/start-web.js — 启动本地浏览器调试服务
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { startWebServer } = require('../main/web-server')

function parsePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`Web 端口必须是 1 到 65535 的整数，实际收到：${value}`)
  }
  return port
}

function parseCliArgs(argv = [], env = process.env) {
  let open = true
  let port = env.MODBUSMATE_WEB_PORT === undefined ? 8765 : parsePort(env.MODBUSMATE_WEB_PORT)
  const dataDir = path.resolve(env.MODBUSMATE_DATA_DIR || path.join(os.homedir(), '.modbusmate'))
  // 局域网访问：--lan 或环境变量 MODBUSMATE_WEB_LAN=1 开启
  let lan = env.MODBUSMATE_WEB_LAN === '1' || env.MODBUSMATE_WEB_LAN === 'true'
  // 免令牌：--no-token 或 MODBUSMATE_WEB_NO_TOKEN=1（局域网现场便捷用，牺牲访问控制）
  let noToken = env.MODBUSMATE_WEB_NO_TOKEN === '1' || env.MODBUSMATE_WEB_NO_TOKEN === 'true'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-open') {
      open = false
    } else if (arg === '--lan') {
      lan = true
    } else if (arg === '--no-token') {
      noToken = true
    } else if (arg === '--port') {
      if (argv[index + 1] === undefined) throw new TypeError('--port 后必须提供端口号')
      port = parsePort(argv[index + 1])
      index += 1
    } else {
      throw new TypeError(`不支持的启动参数：${arg}`)
    }
  }
  return { open, port, dataDir, lan, noToken }
}

// 枚举本机所有 IPv4 局域网地址（排除回环）
function lanAddresses() {
  const result = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

function createOpenCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '', url],
      windowsVerbatimArguments: true,
    }
  }
  return { command: 'xdg-open', args: [url] }
}

function openBrowser(url, platform = process.platform, spawnProcess = spawn) {
  const command = createOpenCommand(platform, url)
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let app
  try {
    const options = parseCliArgs(argv, env)
    app = await startWebServer({ port: options.port, dataDir: options.dataDir, allowLan: options.lan, requireToken: !options.noToken })
    console.log(`ModbusMate 本地调试地址：${app.url}`)
    console.log(`本地数据目录：${options.dataDir}`)
    if (options.lan) {
      const port = app.address.port
      const suffix = app.requireToken ? `/?token=${encodeURIComponent(app.token)}` : '/'
      const ips = lanAddresses()
      if (ips.length) {
        console.log(app.requireToken
          ? '局域网访问地址（同一网络的其它设备可用，需带下方完整地址含令牌）：'
          : '局域网访问地址（免令牌，同一网络设备直接打开即可）：')
        for (const ip of ips) console.log(`  http://${ip}:${port}${suffix}`)
      } else {
        console.log('已开启局域网模式，但未检测到局域网 IPv4 地址（请确认已连接网络）。')
      }
      console.log('⚠️ 局域网模式下，同网络内能访问该地址的人都能操作，请勿在不可信网络使用。')
    }

    if (options.open) {
      openBrowser(app.url).catch(error => {
        console.warn(`浏览器自动打开失败，服务仍在运行；请手动访问上方地址。原因：${error.message}`)
      })
    }

    let stopping = false
    const shutdown = signal => {
      if (stopping) return
      stopping = true
      app.close().then(
        () => { process.exitCode = 0 },
        error => {
          console.error(`${signal} 触发关闭时发生异常：${error.message}`)
          process.exitCode = 1
        },
      )
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    return app
  } catch (error) {
    if (app) await app.close().catch(() => undefined)
    console.error(`ModbusMate 本地 Web 服务启动失败：${error.message}`)
    process.exitCode = 1
    throw error
  }
}

if (require.main === module) {
  main().catch(() => undefined)
}

module.exports = { parseCliArgs, createOpenCommand, openBrowser, main }
