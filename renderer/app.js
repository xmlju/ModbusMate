// renderer/app.js — 界面逻辑（v0.3：左侧导航驱动 5 页，所有代码以 $ 开头的函数为统一 DOM 入口）
const $ = id => document.getElementById(id)

const state = {
  connected: false,
  polling: false,
  area: 'holding', addr: 0, count: 10, interval: 1000,
  rows: [],
  values: [],
  prevValues: [],
  plcMode: true,
  dashboard: false,
}
const isBitArea = () => state.area === 'coil' || state.area === 'discrete'
const isWritableArea = () => state.area === 'coil' || state.area === 'holding'
const cleanErr = msg => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ── 入口：直接进主应用（激活码逻辑已注释禁用）──
async function init() { startApp() }

async function startApp() {
  const cfg = await window.api.loadConfig()
  if (cfg.host) $('host').value = cfg.host
  if (cfg.port) $('port').value = cfg.port
  if (cfg.unitId) $('unitId').value = cfg.unitId
  if (cfg.area) $('area').value = cfg.area
  if (cfg.addr !== undefined) $('startAddr').value = cfg.addr
  if (cfg.count) $('count').value = cfg.count
  if (cfg.interval) $('interval').value = cfg.interval

  // 调试工作台事件
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

  // ── 导航 ──
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchNav(item.dataset.page))
  })

  // ── 设备总览页按钮 ──
  $('ovAddInstBtn').addEventListener('click', () => DeviceUI.openInstanceModal())
  $('ovFirstAddBtn').addEventListener('click', () => DeviceUI.openInstanceModal())

  // ── 设备调试页 ──
  $('ddDeviceSel').addEventListener('change', () => renderDebugForDevice($('ddDeviceSel').value))
  $('ddToggleBtn').addEventListener('click', async () => {
    const id = $('ddDeviceSel').value
    if (id && DeviceUI.state.running[id]) {
      await DeviceUI.toggleInstance(id)
      renderDebugForDevice(id)
    }
  })

  // ── 通信日志页 ──
  $('logClearBtn').addEventListener('click', () => {
    $('logFull').innerHTML = ''
  })

  // ── 类型/实例管理页 ──
  $('mgrAddTypeBtn').addEventListener('click', () => DeviceUI.openTypeEditorForNew())
  $('mgrAddInstBtn').addEventListener('click', () => DeviceUI.openInstanceModal())

  // ── DeviceUI ──
  window._appLogFn = (level, msg) => log(level, msg)
  DeviceUI.loadFromConfig(cfg)
  DeviceUI.init()

  // 关闭弹窗
  $('typeCancelBtn').addEventListener('click', () => {
    $('typeEditorModal').classList.add('hidden')
  })
  $('instModalCancel').addEventListener('click', () => {
    $('instanceModal').classList.add('hidden')
  })

  // 初始渲染
  DeviceUI.renderOverviewPage()
  DeviceUI.renderMgrPage()
  populateDeviceDebugSel()

  log('info', 'ModbusMate v0.3 就绪，请连接设备')
}

// ── 导航页切换 ──
function switchNav(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === page + 'Page'))
}

// ── 设备总览页：数据/状态变化时刷新 ──
function refreshOverview() {
  DeviceUI.renderOverviewPage()
  updateOnlineOfflinePills()
  populateDeviceDebugSel()
}

function updateOnlineOfflinePills() {
  let on = 0, off = 0
  DeviceUI.state.instances.forEach(inst => {
    const s = DeviceUI.state.statuses[inst.id]
    if (DeviceUI.state.running[inst.id] && (s === 'connected' || s === 'connecting')) on++
    else if (DeviceUI.state.running[inst.id] && (s === 'offline' || s === 'error')) off++
  })
  $('devOnlinePill').innerHTML = `<span class="dot good"></span>在线 ${on}`
  $('devOfflinePill').innerHTML = `<span class="dot crit"></span>离线 ${off}`
}

// ── 设备调试页 ──
function populateDeviceDebugSel() {
  const sel = $('ddDeviceSel')
  const curVal = sel.value
  sel.innerHTML = '<option value="">— 选择设备 —</option>'
  DeviceUI.state.instances.forEach(inst => {
    sel.innerHTML += `<option value="${inst.id}">${inst.name} (${inst.host}:${inst.port})</option>`
  })
  if (curVal && [...sel.options].some(o => o.value === curVal)) sel.value = curVal
}

function renderDebugForDevice(id) {
  const ddContent = $('ddContent')
  const ddStatus = $('ddStatus')
  const ddMeta = $('ddMeta')
  const ddToggleBtn = $('ddToggleBtn')

  if (!id) {
    ddContent.innerHTML = '<div class="dev-empty-page"><p>请从「设备总览」启动一个设备实例后，在此选择查看点位详情</p></div>'
    ddStatus.innerHTML = '<span class="dot idle"></span>未选择'
    ddMeta.textContent = ''
    ddToggleBtn.style.display = 'none'
    return
  }

  const inst = DeviceUI.state.instances.find(i => i.id === id)
  if (!inst) return
  const type = DeviceUI.state.types.find(t => t.id === inst.typeId)
  const running = DeviceUI.state.running[id]
  const status = DeviceUI.state.statuses[id] || 'disconnected'

  ddStatus.innerHTML = running
    ? `<span class="dot ${status}"></span>${status === 'connected' ? '在线' : status === 'offline' ? '离线·重连中' : '连接中'}`
    : `<span class="dot idle"></span>未启动`
  ddMeta.textContent = `${inst.host}:${inst.port} · 从站${inst.unitId} · 周期 ${inst.interval}ms`
  ddToggleBtn.style.display = 'block'
  ddToggleBtn.textContent = running ? '⏸ 停止' : '▶ 启动'

  if (!type) {
    ddContent.innerHTML = '<div class="dev-empty-page"><p>类型未找到</p></div>'
    return
  }

  // 点位表
  const blocks = DeviceUI.state.data[id]
  let tableHtml = `<div class="panel"><div class="panel-head">
    <span class="dev-name">${escapeHtml(inst.name)}</span></div>
    <div class="panel-scroll"><table><thead><tr><th>点位</th><th>区域</th><th>地址</th><th>类型</th><th>原始值</th><th>解析值</th><th>操作</th></tr></thead><tbody>`

  if (type.points.length === 0) {
    tableHtml += '<tr><td colspan="7" style="text-align:center;color:var(--ink-3)">该类型无点位</td></tr>'
  } else {
    type.points.forEach((p, idx) => {
      const slice = blocks ? ReadPlan.pickValues(blocks, { area: p.area, addr: p.addr, words: DeviceUI.getWords(p.area, p.type) }) : null
      const dispAddr = Codec.toPlcAddress(p.addr, p.area)
      const areaLabel = { holding: '保持寄存器', input: '输入寄存器', coil: '线圈', discrete: '离散输入' }[p.area] || p.area
      const typeLabel = Codec.TYPES[p.type]?.label || p.type
      const kLabel = p.k !== 1 || p.b !== 0 ? ` ×${p.k}${p.b >= 0 ? `+${p.b}` : p.b}` : ''
      const isReadonly = p.area === 'input' || p.area === 'discrete'

      let rawStr = '—', parsedStr = '—'
      if (slice) {
        if (p.area === 'coil' || p.area === 'discrete') {
          rawStr = String(slice[0])
          parsedStr = slice[0] ? 'ON' : 'OFF'
        } else {
          rawStr = '0x' + slice.map(v => v.toString(16).toUpperCase().padStart(4, '0')).join(' ')
          const parsed = Codec.decode(slice, 0, p.type, p.wordOrder || 'AB')
          if (parsed !== null && typeof parsed === 'number') {
            const y = Codec.applyTransform(parsed, { k: p.k ?? 1, b: p.b ?? 0, decimals: p.decimals ?? null })
            parsedStr = (typeof y === 'number' && !Number.isInteger(y) && p.decimals == null ? y.toFixed(2) : String(y))
              + (p.unit ? ` ${p.unit}` : '')
          } else if (parsed !== null) {
            parsedStr = String(parsed)
          }
        }
      }

      tableHtml += `<tr>
        <td class="val">${escapeHtml(p.name)}</td>
        <td>${areaLabel}</td>
        <td class="mono">${dispAddr}</td>
        <td>${typeLabel}${kLabel}</td>
        <td class="mono">${rawStr}</td>
        <td class="val">${parsedStr}</td>
        <td>${isReadonly ? '' : '<button class="btn ghost sm dd-write" data-inst="' + id + '" data-area="' + p.area + '" data-addr="' + p.addr + '" data-type="' + p.type + '" data-order="' + (p.wordOrder || 'AB') + '">写入</button>'}</td>
      </tr>`
    })
  }

  tableHtml += '</tbody></table></div>'

  // 迷你日志条（最近 5 条当前设备日志）
  tableHtml += '<div class="log-strip" id="ddLogStrip"></div></div>'

  ddContent.innerHTML = tableHtml

  // 绑定写入按钮
  ddContent.querySelectorAll('.dd-write').forEach(btn => {
    btn.addEventListener('click', () => {
      const instId = btn.dataset.inst
      const area = btn.dataset.area
      const addr = Number(btn.dataset.addr)
      const type = btn.dataset.type
      const wordOrder = btn.dataset.order
      openDDWriteModal(instId, area, addr, type, wordOrder)
    })
  })
}

// ── 设备调试页写入弹窗（复用现有弹窗）──
let ddWriteTarget = null

function openDDWriteModal(instId, area, addr, type, wordOrder) {
  ddWriteTarget = { instId, area, addr, type, wordOrder }
  const dispAddr = Codec.toPlcAddress(addr, area)
  const isCoil = area === 'coil'
  $('modalTitle').textContent = `写入 ${dispAddr}（${isCoil ? '线圈' : Codec.TYPES[type].label}）`
  $('modalHint').textContent = isCoil ? '输入 1=ON，0=OFF' : type === 'hex' ? '输入十六进制，如 1A2B' : '输入数值'
  $('modalInput').value = ''
  $('modalError').textContent = ''
  $('writeModal').classList.remove('hidden')
  $('modalInput').focus()
  // 覆盖 confirmWrite 逻辑
  $('modalOk').onclick = confirmDDWrite
}

async function confirmDDWrite() {
  if (!ddWriteTarget) return
  const { instId, area, addr, type, wordOrder } = ddWriteTarget
  const raw = $('modalInput').value.trim()
  let words
  try {
    if (area === 'coil') {
      if (raw !== '0' && raw !== '1') throw new Error('线圈只能写 0 或 1')
      words = [Number(raw)]
    } else {
      words = Codec.encode(raw, type, wordOrder)
    }
  } catch (err) {
    $('modalError').textContent = err.message; return
  }
  try {
    await window.api.deviceWrite({ id: instId, area, addr, words })
    log('info', `写入成功：${instId} ${addr} ← ${raw}`)
    closeModal()
  } catch (err) {
    $('modalError').textContent = `写入失败：${cleanErr(err.message)}`
  }
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
  // 映射状态 → CSS 类名（dot.good / dot.warn / dot.crit / dot.idle / dot.connecting）
  const dotMap = { connected: 'good', disconnected: 'idle', offline: 'crit', error: 'crit', connecting: 'connecting' }
  $('statusDot').className = 'dot ' + (dotMap[s] || s)
  const labels = { connected: '已连接', disconnected: '未连接', offline: '连接中断，自动重连中…', connecting: '连接中…', error: '连接失败' }
  $('statusText').textContent = labels[s] || s
  $('connectBtn').textContent = state.connected ? '断开' : '连接'
  if (s === 'disconnected' || s === 'error') { state.polling = false; $('pollBtn').textContent = '▶ 开始监控' }
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
    state.polling = false; $('pollBtn').textContent = '▶ 开始监控'
    return
  }
  if (!state.connected) return log('error', '请先连接设备')
  const area = $('area').value; const addr = Number($('startAddr').value)
  const count = Number($('count').value); const interval = Number($('interval').value)
  if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return log('error', '起始地址应为 0~65535 的整数（协议地址，从 0 起）')
  if (!Number.isInteger(count) || count < 1 || count > 120) return log('error', '数量应为 1~120 的整数')
  const areaChanged = area !== state.area
  Object.assign(state, { area, addr, count, interval })
  const bit = isBitArea()
  state.rows = Array.from({ length: count }, (_, i) =>
    bit ? { type: 'bit' } : (!areaChanged && state.rows[i] && state.rows[i].type !== 'bit' ? state.rows[i] : { type: 'uint16', wordOrder: 'AB' }))
  const savedCfg = await window.api.loadConfig()
  if (savedCfg.rowsKey === `${area}:${addr}:${count}` && Array.isArray(savedCfg.rows)) state.rows = savedCfg.rows
  state.values = []; state.prevValues = []; renderTable()
  await window.api.startPoll({ area, addr, count, interval })
  const cfg = await window.api.loadConfig()
  await window.api.saveConfig({ ...cfg, area, addr, count, interval, rows: state.rows, rowsKey: `${area}:${addr}:${count}` })
  state.polling = true; $('pollBtn').textContent = '⏸ 停止监控'
  log('info', `开始监控 ${area} 区域，地址 ${addr} 起 ${count} 点，周期 ${interval}ms`)
}

function onData(d) {
  state.prevValues = state.values; state.values = d.values; renderValues(); renderDashboard()
}

// ── 表格 ──
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
  const tbody = $('tbody'); tbody.innerHTML = ''
  const bit = isBitArea(); const writable = isWritableArea()
  for (let i = 0; i < state.count; i++) {
    const tr = document.createElement('tr'); tr.dataset.index = i
    const protoAddr = state.addr + i
    const dispAddr = state.plcMode ? Codec.toPlcAddress(protoAddr, state.area) : protoAddr
    let typeCell
    if (bit) { typeCell = '<td>开关量</td>' }
    else {
      const row = state.rows[i]
      const opts = Object.entries(Codec.TYPES).map(([k, t]) => `<option value="${k}" ${row.type === k ? 'selected' : ''}>${t.label}</option>`).join('')
      const orderHidden = Codec.TYPES[row.type].words === 2 ? '' : 'hidden'
      typeCell = `<td><select class="typeSel">${opts}</select><select class="orderSel ${orderHidden}"><option ${row.wordOrder === 'AB' ? 'selected' : ''}>AB</option><option ${row.wordOrder === 'BA' ? 'selected' : ''}>BA</option></select></td>`
    }
    const t = state.rows[i].transform
    const tfCell = bit ? '<td></td>' : `<td><button class="tfBtn">${t ? escapeHtml(t.name || formatTransform(t)) : '设置'}</button></td>`
    tr.innerHTML = `<td>${dispAddr}</td>${typeCell}<td class="raw">—</td><td class="parsed">—</td>${tfCell}<td>${writable ? '<button class="writeBtn">写入</button>' : ''}</td>`
    tbody.appendChild(tr)
  }
  tbody.querySelectorAll('.typeSel').forEach(sel => sel.addEventListener('change', e => {
    state.rows[Number(e.target.closest('tr').dataset.index)].type = e.target.value; renderTable()
  }))
  tbody.querySelectorAll('.orderSel').forEach(sel => sel.addEventListener('change', e => {
    state.rows[Number(e.target.closest('tr').dataset.index)].wordOrder = e.target.value; renderValues()
  }))
  tbody.querySelectorAll('.writeBtn').forEach(btn => btn.addEventListener('click', e => {
    openWriteModal(Number(e.target.closest('tr').dataset.index))
  }))
  tbody.querySelectorAll('.tfBtn').forEach(btn => btn.addEventListener('click', e => {
    openTransformModal(Number(e.target.closest('tr').dataset.index))
  }))
  renderValues()
}

function formatTransform(t) {
  let s = `×${t.k}`
  if (t.b) s += t.b > 0 ? `+${t.b}` : `${t.b}`
  if (t.unit) s += ` ${t.unit}`; return s
}

function renderValues() {
  const bit = isBitArea(); const occ = bit ? [] : computeOccupied()
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const i = Number(tr.dataset.index); const rawCell = tr.querySelector('.raw'); const parsedCell = tr.querySelector('.parsed')
    const v = state.values[i]
    if (occ[i]) { rawCell.textContent = '—'; parsedCell.textContent = '（由上行 32 位占用）'; tr.classList.add('occupied'); return }
    tr.classList.remove('occupied')
    if (v === undefined) { rawCell.textContent = '—'; parsedCell.textContent = '—'; return }
    if (bit) { rawCell.textContent = v; parsedCell.textContent = v ? 'ON' : 'OFF' }
    else {
      rawCell.textContent = '0x' + v.toString(16).toUpperCase().padStart(4, '0')
      const { type, wordOrder, transform } = state.rows[i]
      const parsed = Codec.decode(state.values, i, type, wordOrder)
      if (parsed === null) { parsedCell.textContent = '（缺下一寄存器）'; parsedCell.title = '' }
      else if (transform && typeof parsed === 'number') {
        const y = Codec.applyTransform(parsed, transform)
        const shown = typeof y === 'number' && !Number.isInteger(y) && transform.decimals == null ? y.toFixed(4) : String(y)
        parsedCell.textContent = transform.unit ? `${shown} ${transform.unit}` : shown; parsedCell.title = `原始解析值：${parsed}`
      } else { parsedCell.textContent = typeof parsed === 'number' && !Number.isInteger(parsed) ? parsed.toFixed(4) : String(parsed); parsedCell.title = '' }
    }
    if (state.prevValues.length > 0 && state.prevValues[i] !== v) {
      tr.classList.add('flash'); setTimeout(() => tr.classList.remove('flash'), 600)
    }
  })
}

// ── 写入弹窗（调试工作台）──
let writeTarget = null
function openWriteModal(i) {
  const coil = state.area === 'coil'; const row = state.rows[i]
  writeTarget = { index: i }
  const dispAddr = state.plcMode ? Codec.toPlcAddress(state.addr + i, state.area) : state.addr + i
  $('modalTitle').textContent = `写入地址 ${dispAddr}（${coil ? '线圈' : Codec.TYPES[row.type].label}）`
  $('modalHint').textContent = coil ? '输入 1=ON，0=OFF' : row.type === 'hex' ? '输入十六进制，如 1A2B' : '输入数值'
  $('modalInput').value = ''; $('modalError').textContent = ''; $('writeModal').classList.remove('hidden'); $('modalInput').focus()
  $('modalOk').onclick = confirmWrite
}
function closeModal() { $('writeModal').classList.add('hidden'); writeTarget = null; ddWriteTarget = null }
async function confirmWrite() {
  if (!writeTarget) return
  const i = writeTarget.index; const raw = $('modalInput').value.trim(); let words
  try {
    if (state.area === 'coil') { if (raw !== '0' && raw !== '1') throw new Error('线圈只能写 0 或 1'); words = [Number(raw)] }
    else { words = Codec.encode(raw, state.rows[i].type, state.rows[i].wordOrder) }
  } catch (err) { $('modalError').textContent = err.message; return }
  try {
    await window.api.write({ area: state.area, addr: state.addr + i, words })
    log('info', `写入成功：地址 ${state.addr + i} ← ${raw}`); closeModal()
  } catch (err) { $('modalError').textContent = `写入失败：${cleanErr(err.message)}` }
}

// ── 行设置弹窗 ──
let transformTarget = null
function openTransformModal(i) {
  transformTarget = { index: i }; const t = state.rows[i].transform || {}
  const dispAddr = state.plcMode ? Codec.toPlcAddress(state.addr + i, state.area) : state.addr + i
  $('tfTitle').textContent = `地址 ${dispAddr} 行设置`
  $('tfName').value = t.name ?? ''; $('tfUnit').value = t.unit ?? ''
  $('tfK').value = t.k ?? 1; $('tfB').value = t.b ?? 0; $('tfDecimals').value = t.decimals ?? ''
  $('tfError').textContent = ''; $('transformModal').classList.remove('hidden')
}
function closeTransformModal() { $('transformModal').classList.add('hidden'); transformTarget = null }
function saveTransform() {
  if (!transformTarget) return
  const k = Number($('tfK').value); const b = Number($('tfB').value)
  const dRaw = $('tfDecimals').value.trim(); const decimals = dRaw === '' ? null : Number(dRaw)
  if (Number.isNaN(k) || Number.isNaN(b)) { $('tfError').textContent = '系数 k 和偏移 b 必须是数字'; return }
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 6)) { $('tfError').textContent = '小数位应为 0~6 的整数，留空表示自动'; return }
  state.rows[transformTarget.index].transform = { name: $('tfName').value.trim(), unit: $('tfUnit').value.trim(), k, b, decimals }
  closeTransformModal(); renderTable(); renderDashboard(true); saveRowsConfig()
}
function clearTransform() {
  if (!transformTarget) return; delete state.rows[transformTarget.index].transform
  closeTransformModal(); renderTable(); renderDashboard(true); saveRowsConfig()
}
async function saveRowsConfig() {
  const cfg = await window.api.loadConfig(); await window.api.saveConfig({ ...cfg, rows: state.rows, rowsKey: `${state.area}:${state.addr}:${state.count}` })
}

// ── 仪表盘视图（调试工作台）──
let dashPrev = {}
function toggleView() {
  state.dashboard = !state.dashboard; $('tableView').classList.toggle('hidden', state.dashboard)
  $('dashView').classList.toggle('hidden', !state.dashboard)
  $('viewBtn').textContent = state.dashboard ? '表格' : '仪表盘'
  if (state.dashboard) renderDashboard(true)
}
function renderDashboard(rebuild = false) {
  if (!state.dashboard) return
  const dash = $('dashView'); const occ = isBitArea() ? [] : computeOccupied()
  const items = []
  state.rows.forEach((row, i) => {
    if (!row.transform?.name || occ[i]) return
    const v = state.values[i]; let display = '—', num = null
    if (v !== undefined) {
      if (row.type === 'bit') { display = v ? 'ON' : 'OFF' }
      else {
        const parsed = Codec.decode(state.values, i, row.type, row.wordOrder)
        if (parsed !== null) {
          const y = Codec.applyTransform(parsed, row.transform); num = typeof y === 'number' ? y : null
          display = typeof y === 'number' && !Number.isInteger(y) && row.transform.decimals == null ? y.toFixed(2) : String(y)
        }
      }
    }
    items.push({ i, name: row.transform.name, unit: row.transform.unit || '', display, num })
  })
  if (rebuild || dash.childElementCount !== Math.max(items.length, 1)) {
    dashPrev = {}; dash.innerHTML = items.length === 0
      ? '<div class="dash-empty">还没有数据点：在表格视图点某行的「设置」，填上名称即可加入仪表盘</div>'
      : items.map(it => `<div class="dash-card" data-i="${it.i}"><div class="dash-name">${escapeHtml(it.name)}</div><div class="dash-value"><span class="dash-num">—</span><span class="dash-unit">${escapeHtml(it.unit)}</span></div><div class="dash-bar hidden"><div></div></div></div>`).join('')
  }
  items.forEach(it => {
    const card = dash.querySelector(`.dash-card[data-i="${it.i}"]`); if (!card) return
    card.querySelector('.dash-num').textContent = it.display
    const bar = card.querySelector('.dash-bar')
    if (it.unit === '%' && it.num !== null && it.num >= 0 && it.num <= 100) { bar.classList.remove('hidden'); bar.firstElementChild.style.width = it.num + '%' }
    else { bar.classList.add('hidden') }
    if (dashPrev[it.i] !== undefined && dashPrev[it.i] !== it.display) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 600) }
    dashPrev[it.i] = it.display
  })
}

// ── 日志（全局 + 通信日志页同步）──
const logs = []
function log(level, message) {
  const time = new Date().toTimeString().slice(0, 8)
  logs.push({ time, level, message })
  if (logs.length > 200) logs.shift()
  // 调试工作台日志栏
  const box = $('logBox')
  if (box) { box.innerHTML = logs.map(l => `<div class="log-${l.level}">[${l.time}] ${escapeHtml(l.message)}</div>`).join(''); box.scrollTop = box.scrollHeight }
  // 通信日志页
  const full = $('logFull')
  if (full) full.innerHTML += `<div class="log-entry"><span class="ts">[${time}]</span><span class="log-${level}">${escapeHtml(message)}</span></div>`
  // 设备调试页迷你日志条（匹配当前选中设备）
  const sel = $('ddDeviceSel')
  const ddStrip = $('ddLogStrip')
  if (sel && ddStrip) {
    const inst = sel.value && DeviceUI.state.instances.find(i => i.id === sel.value)
    if (inst && message.includes(inst.name)) ddStrip.innerHTML += `<span class="${level === 'error' ? 'err' : level === 'info' ? 'good' : ''}">[${time}] ${escapeHtml(message)}</span>`
  }
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

document.addEventListener('DOMContentLoaded', init)
