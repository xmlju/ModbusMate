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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-open') {
      open = false
    } else if (arg === '--port') {
      if (argv[index + 1] === undefined) throw new TypeError('--port 后必须提供端口号')
      port = parsePort(argv[index + 1])
      index += 1
    } else {
      throw new TypeError(`不支持的启动参数：${arg}`)
    }
  }
  return { open, port, dataDir }
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
    app = await startWebServer({ port: options.port, dataDir: options.dataDir })
    console.log(`ModbusMate 本地调试地址：${app.url}`)
    console.log(`本地数据目录：${options.dataDir}`)

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
