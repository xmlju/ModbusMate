// renderer/app.js — 界面逻辑（依赖 codec.js 暴露的全局 Codec 与 preload 暴露的 window.api）
const $ = id => document.getElementById(id)

const state = {
  connected: false,
  polling: false,
  area: 'holding', addr: 0, count: 10, interval: 1000,
  rows: [],          // 每行 { type, wordOrder, transform? }；transform = { name, unit, k, b, decimals }；位区域行为 { type: 'bit' }
  values: [],        // 最新原始值
  prevValues: [],    // 上一轮值，用于变化高亮
  plcMode: true,
  dashboard: false,  // true = 仪表盘视图
}

const isBitArea = () => state.area === 'coil' || state.area === 'discrete'
const isWritableArea = () => state.area === 'coil' || state.area === 'holding'
// IPC 抛错带 "Error invoking remote method 'xx': Error: " 前缀，剥掉只留业务消息
const cleanErr = msg => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ── 入口：直接进主应用（激活码逻辑已注释禁用）──
async function init() {
  startApp()
}

async function startApp() {
  $('app').classList.remove('hidden')
  // 恢复上次配置
  const cfg = await window.api.loadConfig()
  if (cfg.host) $('host').value = cfg.host
  if (cfg.port) $('port').value = cfg.port
  if (cfg.unitId) $('unitId').value = cfg.unitId
  if (cfg.area) $('area').value = cfg.area
  if (cfg.addr !== undefined) $('startAddr').value = cfg.addr
  if (cfg.count) $('count').value = cfg.count
  if (cfg.interval) $('interval').value = cfg.interval

  $('connectBtn').addEventListener('click', onConnectClick)
  $('pollBtn').addEventListener('click', onPollClick)
  $('plcMode').addEventListener('change', () => { state.plcMode = $('plcMode').checked; renderTable() })
  $('logToggle').addEventListener('click', () => $('logPanel').classList.toggle('collapsed'))
  $('modalCancel').addEventListener('click', closeModal)
  $('modalOk').addEventListener('click', confirmWrite)
  $('viewBtn').addEventListener('click', toggleView)
  $('tfCancel').addEventListener('click', closeTransformModal)
  $('tfOk').addEventListener('click', saveTransform)
  $('tfClear').addEventListener('click', clearTransform)

  window.api.onData(onData)
  window.api.onStatus(st => onStatus(st))
  window.api.onLog(l => log(l.level, l.message))
  log('info', 'ModbusMate 就绪，请连接设备')
}

// ── 连接 ──
async function onConnectClick() {
  if (state.connected) return window.api.disconnect()
  const params = { host: $('host').value.trim(), port: Number($('port').value), unitId: Number($('unitId').value) }
  if (!params.host) return log('error', '请输入设备 IP 地址')
  setStatus('connecting')
  try {
    await window.api.connect(params)
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, ...params })
    log('info', `已连接 ${params.host}:${params.port}（从站 ${params.unitId}）`)
  } catch (err) {
    setStatus('error')
    log('error', `连接失败：${friendlyConnectError(cleanErr(err.message), params)}`)
  }
}

function friendlyConnectError(msg, p) {
  if (msg.includes('ECONNREFUSED')) return `${p.host}:${p.port} 拒绝连接，请确认设备已开启 Modbus-TCP 服务、端口号正确`
  if (msg.includes('EHOSTUNREACH') || msg.includes('ETIMEDOUT') || /Timed out/i.test(msg)) return `${p.host}:${p.port} 无响应，请检查设备电源、网线和 IP 设置`
  if (msg.includes('ENOTFOUND')) return `找不到主机 ${p.host}，请检查 IP 地址`
  return msg
}

function setStatus(s) {
  state.connected = s === 'connected'
  $('statusDot').className = 'dot ' + s
  const labels = { connected: '已连接', disconnected: '未连接', offline: '连接中断，自动重连中…', connecting: '连接中…', error: '连接失败' }
  $('statusText').textContent = labels[s] || s
  $('connectBtn').textContent = state.connected ? '断开' : '连接'
  if (s === 'disconnected' || s === 'error') {
    state.polling = false
    $('pollBtn').textContent = '▶ 开始监控'
  }
}

function onStatus(st) {
  setStatus(st.state)
  if (st.state === 'offline') log('error', '设备连接中断，每 5 秒自动重连…')
  if (st.state === 'connected' && state.polling) log('info', '连接已恢复，继续监控')
}

// ── 监控 ──
async function onPollClick() {
  if (state.polling) {
    await window.api.stopPoll()
    state.polling = false
    $('pollBtn').textContent = '▶ 开始监控'
    return
  }
  if (!state.connected) return log('error', '请先连接设备')
  const area = $('area').value
  const addr = Number($('startAddr').value)
  const count = Number($('count').value)
  const interval = Number($('interval').value)
  if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return log('error', '起始地址应为 0~65535 的整数（协议地址，从 0 起）')
  if (!Number.isInteger(count) || count < 1 || count > 120) return log('error', '数量应为 1~120 的整数')

  const areaChanged = area !== state.area
  Object.assign(state, { area, addr, count, interval })
  const bit = isBitArea()
  // 区域类型不变时保留每行已设置的数据类型
  state.rows = Array.from({ length: count }, (_, i) =>
    bit ? { type: 'bit' } : (!areaChanged && state.rows[i] && state.rows[i].type !== 'bit' ? state.rows[i] : { type: 'uint16', wordOrder: 'AB' }))
  // 同一监控配置（区域:地址:数量）恢复上次保存的行设置（类型/字序/名称/公式）
  const savedCfg = await window.api.loadConfig()
  if (savedCfg.rowsKey === `${area}:${addr}:${count}` && Array.isArray(savedCfg.rows)) {
    state.rows = savedCfg.rows
  }
  state.values = []
  state.prevValues = []
  renderTable()

  await window.api.startPoll({ area, addr, count, interval })
  const cfg = await window.api.loadConfig()
  await window.api.saveConfig({ ...cfg, area, addr, count, interval, rows: state.rows, rowsKey: `${area}:${addr}:${count}` })
  state.polling = true
  $('pollBtn').textContent = '⏸ 停止监控'
  log('info', `开始监控 ${area} 区域，地址 ${addr} 起 ${count} 点，周期 ${interval}ms`)
}

function onData(d) {
  state.prevValues = state.values
  state.values = d.values
  renderValues()
  renderDashboard()
}

// ── 表格 ──
// 计算被上一行 32 位类型占用的行
function computeOccupied() {
  const occ = new Array(state.count).fill(false)
  for (let i = 0; i < state.count; i++) {
    if (occ[i]) continue
    const r = state.rows[i]
    if (r && Codec.TYPES[r.type]?.words === 2) occ[i + 1] = true
  }
  return occ
}

function renderTable() {
  const tbody = $('tbody')
  tbody.innerHTML = ''
  const bit = isBitArea()
  const writable = isWritableArea()
  for (let i = 0; i < state.count; i++) {
    const tr = document.createElement('tr')
    tr.dataset.index = i
    const protoAddr = state.addr + i
    const dispAddr = state.plcMode ? Codec.toPlcAddress(protoAddr, state.area) : protoAddr
    let typeCell
    if (bit) {
      typeCell = '<td>开关量</td>'
    } else {
      const row = state.rows[i]
      const opts = Object.entries(Codec.TYPES)
        .map(([k, t]) => `<option value="${k}" ${row.type === k ? 'selected' : ''}>${t.label}</option>`).join('')
      const orderHidden = Codec.TYPES[row.type].words === 2 ? '' : 'hidden'
      typeCell = `<td><select class="typeSel">${opts}</select><select class="orderSel ${orderHidden}"><option ${row.wordOrder === 'AB' ? 'selected' : ''}>AB</option><option ${row.wordOrder === 'BA' ? 'selected' : ''}>BA</option></select></td>`
    }
    // 公式列：位区域不支持；已设置则显示名称或公式概览
    const t = state.rows[i].transform
    const tfCell = bit ? '<td></td>' : `<td><button class="tfBtn">${t ? escapeHtml(t.name || formatTransform(t)) : '设置'}</button></td>`
    tr.innerHTML = `<td>${dispAddr}</td>${typeCell}<td class="raw">—</td><td class="parsed">—</td>${tfCell}<td>${writable ? '<button class="writeBtn">写入</button>' : ''}</td>`
    tbody.appendChild(tr)
  }
  tbody.querySelectorAll('.typeSel').forEach(sel => sel.addEventListener('change', e => {
    const i = Number(e.target.closest('tr').dataset.index)
    state.rows[i].type = e.target.value
    renderTable()   // 32 位占位可能变化，整表重建
  }))
  tbody.querySelectorAll('.orderSel').forEach(sel => sel.addEventListener('change', e => {
    const i = Number(e.target.closest('tr').dataset.index)
    state.rows[i].wordOrder = e.target.value
    renderValues()
  }))
  tbody.querySelectorAll('.writeBtn').forEach(btn => btn.addEventListener('click', e => {
    openWriteModal(Number(e.target.closest('tr').dataset.index))
  }))
  tbody.querySelectorAll('.tfBtn').forEach(btn => btn.addEventListener('click', e => {
    openTransformModal(Number(e.target.closest('tr').dataset.index))
  }))
  renderValues()
}

// 公式按钮概览文本，如 ×0.1−40
function formatTransform(t) {
  let s = `×${t.k}`
  if (t.b) s += t.b > 0 ? `+${t.b}` : `${t.b}`
  if (t.unit) s += ` ${t.unit}`
  return s
}

function renderValues() {
  const bit = isBitArea()
  const occ = bit ? [] : computeOccupied()
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const i = Number(tr.dataset.index)
    const rawCell = tr.querySelector('.raw')
    const parsedCell = tr.querySelector('.parsed')
    const v = state.values[i]
    if (occ[i]) {
      rawCell.textContent = '—'
      parsedCell.textContent = '（由上行 32 位占用）'
      tr.classList.add('occupied')
      return
    }
    tr.classList.remove('occupied')
    if (v === undefined) { rawCell.textContent = '—'; parsedCell.textContent = '—'; return }
    if (bit) {
      rawCell.textContent = v
      parsedCell.textContent = v ? 'ON' : 'OFF'
    } else {
      rawCell.textContent = '0x' + v.toString(16).toUpperCase().padStart(4, '0')
      const { type, wordOrder, transform } = state.rows[i]
      const parsed = Codec.decode(state.values, i, type, wordOrder)
      if (parsed === null) {
        parsedCell.textContent = '（缺下一寄存器）'
        parsedCell.title = ''
      } else if (transform && typeof parsed === 'number') {
        // 公式转换后的业务值 + 单位；悬停显示原始解析值
        const y = Codec.applyTransform(parsed, transform)
        const shown = typeof y === 'number' && !Number.isInteger(y) && transform.decimals == null ? y.toFixed(4) : String(y)
        parsedCell.textContent = transform.unit ? `${shown} ${transform.unit}` : shown
        parsedCell.title = `原始解析值：${parsed}`
      } else {
        parsedCell.textContent = typeof parsed === 'number' && !Number.isInteger(parsed) ? parsed.toFixed(4) : String(parsed)
        parsedCell.title = ''
      }
    }
    // 变化高亮：值与上一轮不同则闪烁
    if (state.prevValues.length > 0 && state.prevValues[i] !== v) {
      tr.classList.add('flash')
      setTimeout(() => tr.classList.remove('flash'), 600)
    }
  })
}

// ── 写入弹窗 ──
let writeTarget = null

function openWriteModal(i) {
  const coil = state.area === 'coil'
  const row = state.rows[i]
  writeTarget = { index: i }
  const dispAddr = state.plcMode ? Codec.toPlcAddress(state.addr + i, state.area) : state.addr + i
  $('modalTitle').textContent = `写入地址 ${dispAddr}（${coil ? '线圈' : Codec.TYPES[row.type].label}）`
  const baseHint = coil ? '输入 1=ON，0=OFF'
    : row.type === 'hex' ? '输入十六进制，如 1A2B' : '输入数值'
  // 设了公式的行提醒：写入的是原始值，不做反向换算
  $('modalHint').textContent = !coil && row.transform ? `${baseHint}（原始值，不经公式转换）` : baseHint
  $('modalInput').value = ''
  $('modalError').textContent = ''
  $('writeModal').classList.remove('hidden')
  $('modalInput').focus()
}

function closeModal() {
  $('writeModal').classList.add('hidden')
  writeTarget = null
}

async function confirmWrite() {
  if (!writeTarget) return
  const i = writeTarget.index
  const raw = $('modalInput').value.trim()
  let words
  try {
    if (state.area === 'coil') {
      if (raw !== '0' && raw !== '1') throw new Error('线圈只能写 0 或 1')
      words = [Number(raw)]
    } else {
      const { type, wordOrder } = state.rows[i]
      words = Codec.encode(raw, type, wordOrder)
    }
  } catch (err) {
    $('modalError').textContent = err.message
    return
  }
  try {
    await window.api.write({ area: state.area, addr: state.addr + i, words })
    log('info', `写入成功：地址 ${state.addr + i} ← ${raw}`)
    closeModal()
  } catch (err) {
    $('modalError').textContent = `写入失败：${cleanErr(err.message)}`
  }
}

// ── 行设置弹窗（名称 + 线性公式）──
let transformTarget = null

function openTransformModal(i) {
  transformTarget = { index: i }
  const t = state.rows[i].transform || {}
  const dispAddr = state.plcMode ? Codec.toPlcAddress(state.addr + i, state.area) : state.addr + i
  $('tfTitle').textContent = `地址 ${dispAddr} 行设置`
  $('tfName').value = t.name ?? ''
  $('tfUnit').value = t.unit ?? ''
  $('tfK').value = t.k ?? 1
  $('tfB').value = t.b ?? 0
  $('tfDecimals').value = t.decimals ?? ''
  $('tfError').textContent = ''
  $('transformModal').classList.remove('hidden')
}

function closeTransformModal() {
  $('transformModal').classList.add('hidden')
  transformTarget = null
}

function saveTransform() {
  if (!transformTarget) return
  const k = Number($('tfK').value)
  const b = Number($('tfB').value)
  const dRaw = $('tfDecimals').value.trim()
  const decimals = dRaw === '' ? null : Number(dRaw)
  if (Number.isNaN(k) || Number.isNaN(b)) { $('tfError').textContent = '系数 k 和偏移 b 必须是数字'; return }
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 6)) {
    $('tfError').textContent = '小数位应为 0~6 的整数，留空表示自动'; return
  }
  state.rows[transformTarget.index].transform = {
    name: $('tfName').value.trim(), unit: $('tfUnit').value.trim(), k, b, decimals,
  }
  closeTransformModal()
  renderTable()
  renderDashboard(true)
  saveRowsConfig()
}

function clearTransform() {
  if (!transformTarget) return
  delete state.rows[transformTarget.index].transform
  closeTransformModal()
  renderTable()
  renderDashboard(true)
  saveRowsConfig()
}

// 行设置持久化（与监控配置绑定，重启/重新监控时恢复）
async function saveRowsConfig() {
  const cfg = await window.api.loadConfig()
  await window.api.saveConfig({ ...cfg, rows: state.rows, rowsKey: `${state.area}:${state.addr}:${state.count}` })
}

// ── 仪表盘视图（大数字卡片）──
let dashPrev = {}   // 上一轮显示值，用于卡片变化高亮

function toggleView() {
  state.dashboard = !state.dashboard
  $('tableView').classList.toggle('hidden', state.dashboard)
  $('dashView').classList.toggle('hidden', !state.dashboard)
  $('viewBtn').textContent = state.dashboard ? '表格' : '仪表盘'
  if (state.dashboard) renderDashboard(true)
}

function renderDashboard(rebuild = false) {
  if (!state.dashboard) return
  const dash = $('dashView')
  const occ = isBitArea() ? [] : computeOccupied()
  // 收集设置了名称的数据点
  const items = []
  state.rows.forEach((row, i) => {
    if (!row.transform?.name || occ[i]) return
    const v = state.values[i]
    let display = '—', num = null
    if (v !== undefined) {
      if (row.type === 'bit') {
        display = v ? 'ON' : 'OFF'
      } else {
        const parsed = Codec.decode(state.values, i, row.type, row.wordOrder)
        if (parsed !== null) {
          const y = Codec.applyTransform(parsed, row.transform)
          num = typeof y === 'number' ? y : null
          display = typeof y === 'number' && !Number.isInteger(y) && row.transform.decimals == null ? y.toFixed(2) : String(y)
        }
      }
    }
    items.push({ i, name: row.transform.name, unit: row.transform.unit || '', display, num })
  })

  if (rebuild || dash.childElementCount !== Math.max(items.length, 1)) {
    dashPrev = {}
    dash.innerHTML = items.length === 0
      ? '<div class="dash-empty">还没有数据点：在表格视图点某行的「设置」，填上名称即可加入仪表盘</div>'
      : items.map(it => `
        <div class="dash-card" data-i="${it.i}">
          <div class="dash-name">${escapeHtml(it.name)}</div>
          <div class="dash-value"><span class="dash-num">—</span><span class="dash-unit">${escapeHtml(it.unit)}</span></div>
          <div class="dash-bar hidden"><div></div></div>
        </div>`).join('')
  }

  items.forEach(it => {
    const card = dash.querySelector(`.dash-card[data-i="${it.i}"]`)
    if (!card) return
    card.querySelector('.dash-num').textContent = it.display
    // 单位为 % 且值在 0~100 时显示进度条
    const bar = card.querySelector('.dash-bar')
    if (it.unit === '%' && it.num !== null && it.num >= 0 && it.num <= 100) {
      bar.classList.remove('hidden')
      bar.firstElementChild.style.width = it.num + '%'
    } else {
      bar.classList.add('hidden')
    }
    if (dashPrev[it.i] !== undefined && dashPrev[it.i] !== it.display) {
      card.classList.add('flash')
      setTimeout(() => card.classList.remove('flash'), 600)
    }
    dashPrev[it.i] = it.display
  })
}

// 用户输入内容进 innerHTML 前转义
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── 日志（环形缓冲 200 条）──
const logs = []
function log(level, message) {
  const time = new Date().toTimeString().slice(0, 8)
  logs.push({ time, level, message })
  if (logs.length > 200) logs.shift()
  const box = $('logBox')
  box.innerHTML = logs.map(l => `<div class="log-${l.level}">[${l.time}] ${l.message}</div>`).join('')
  box.scrollTop = box.scrollHeight
}

document.addEventListener('DOMContentLoaded', init)
