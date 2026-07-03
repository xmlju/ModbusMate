// renderer/device.js — 设备模式：类型/实例管理 + 按设备分组仪表盘
// 依赖全局 Codec、ReadPlan、window.api；在 app.js 前加载
const DeviceUI = (() => {
  const $ = id => document.getElementById(id)

  // ── 数据状态 ──
  const state = {
    types: [],        // [{ id, name, points: [{ name, area, addr, type, wordOrder, k, b, decimals, unit }] }]
    instances: [],    // [{ id, typeId, name, host, port, unitId, interval }]
    running: {},      // id → true/false，实例运行状态
    data: {},         // id → blocks，最新采集数据
    statuses: {},     // id → 'connected'|'offline'|'disconnected'
    dashPrev: {},     // id → pointKey → prevDisplay，用于卡片变化高亮
  }

  // ── 工具 ──
  let nextId = 1
  function genId() { return `dev${nextId++}` }

  // 根据类型算点位 words；位区域 words=1
  function getWords(area, type) {
    if (area === 'coil' || area === 'discrete') return 1
    return Codec.TYPES[type] ? Codec.TYPES[type].words : 1
  }

  // 根据类型点位 + 实例配置 → device:start 需要的 cfg.blocks
  function buildInstanceCfg(inst) {
    const type = state.types.find(t => t.id === inst.typeId)
    if (!type) return null
    return {
      host: inst.host,
      port: inst.port,
      unitId: inst.unitId,
      interval: inst.interval,
      blocks: ReadPlan.buildReadPlan(
        type.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) }))
      ),
    }
  }

  // 从 config 恢复状态
  function loadFromConfig(cfg) {
    if (Array.isArray(cfg.deviceTypes)) state.types = cfg.deviceTypes
    if (Array.isArray(cfg.deviceInstances)) state.instances = cfg.deviceInstances
    // 取当前已运行的最大 id 号
    state.instances.forEach(inst => {
      const n = parseInt(inst.id.replace('dev', ''))
      if (n >= nextId) nextId = n + 1
    })
  }

  async function saveToConfig() {
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, deviceTypes: state.types, deviceInstances: state.instances })
  }

  // 日志写入公共日志栏（带设备前缀）
  function log(level, message) {
    // 调用 app.js 暴露到 window._appLogFn 的函数；如果不存在直接 console
    if (window._appLogFn) window._appLogFn(level, message)
    else console[level](message)
  }

  // ── 设备工作区渲染 ──
  function renderDeviceArea() {
    const area = $('deviceArea')
    if (!area) return
    // 左侧：实例列表
    let html = '<div class="dev-sidebar"><div class="dev-inst-list">'
    if (state.instances.length === 0) {
      html += '<div class="dev-empty">暂无设备实例<br>点击下方添加</div>'
    } else {
      state.instances.forEach(inst => {
        const type = state.types.find(t => t.id === inst.typeId)
        const status = state.statuses[inst.id] || 'disconnected'
        const running = state.running[inst.id]
        html += `<div class="dev-inst-item" data-id="${inst.id}">
          <span class="dot ${status}"></span>
          <span class="dev-inst-name">${escapeHtml(inst.name)}</span>
          <span class="dev-inst-type">${type ? escapeHtml(type.name) : '（未知类型）'}</span>
          <span class="dev-inst-ip">${escapeHtml(inst.host)}:${inst.port}</span>
          <button class="dev-toggle-btn">${running ? '停止' : '启动'}</button>
        </div>`
      })
    }
    html += '</div><div class="dev-sidebar-btns"><button id="addInstBtn">＋ 添加设备</button><button id="manageTypesBtn">管理类型</button></div></div>'

    // 右侧：按设备分组的仪表盘
    html += '<div class="dev-dash-area" id="devDashArea">'
    const activeInsts = state.instances.filter(inst => state.running[inst.id])
    if (activeInsts.length === 0) {
      html += '<div class="dev-empty">尚未启动任何设备<br>在左侧列表点击「启动」开始采集</div>'
    } else {
      activeInsts.forEach(inst => {
        const type = state.types.find(t => t.id === inst.typeId)
        const status = state.statuses[inst.id] || 'disconnected'
        const offline = !state.running[inst.id] || status === 'offline' || status === 'disconnected'
        html += `<div class="dev-group ${offline ? 'dev-group-offline' : ''}" data-inst-id="${inst.id}">
          <div class="dev-group-header">
            <span class="dot ${status}"></span>
            <span class="dev-group-name">${escapeHtml(inst.name)}</span>
            <span class="dev-group-ip">${escapeHtml(inst.host)}:${inst.port}</span>
          </div>
          <div class="dev-group-cards"></div>
        </div>`
      })
    }
    html += '</div>'

    area.innerHTML = html

    // 绑定按钮事件
    const addBtn = $('addInstBtn')
    const mgrBtn = $('manageTypesBtn')
    if (addBtn) addBtn.addEventListener('click', openInstanceModal)
    if (mgrBtn) mgrBtn.addEventListener('click', openTypeManager)

    // 绑定启停按钮
    area.querySelectorAll('.dev-toggle-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const id = e.target.closest('.dev-inst-item').dataset.id
        toggleInstance(id)
      })
    })
  }

  // 渲染某实例的卡片（刷新数据用）
  function renderInstanceCards(instId) {
    const group = document.querySelector(`.dev-group[data-inst-id="${instId}"]`)
    if (!group) return
    const inst = state.instances.find(i => i.id === instId)
    const type = state.types.find(t => t.id === inst?.typeId)
    const blocks = state.data[instId]
    if (!inst || !type || !blocks) {
      group.querySelector('.dev-group-cards').innerHTML = '<div class="dev-empty">等待数据…</div>'
      return
    }
    const cardsContainer = group.querySelector('.dev-group-cards')
    let html = ''
    type.points.forEach((p, idx) => {
      const slice = ReadPlan.pickValues(blocks, { area: p.area, addr: p.addr, words: getWords(p.area, p.type) })
      let display = '—', num = null
      if (slice) {
        if (p.area === 'coil' || p.area === 'discrete') {
          display = slice[0] ? 'ON' : 'OFF'
        } else {
          const parsed = Codec.decode(slice, 0, p.type, p.wordOrder || 'AB')
          if (parsed !== null && typeof parsed === 'number') {
            const y = Codec.applyTransform(parsed, { k: p.k ?? 1, b: p.b ?? 0, decimals: p.decimals ?? null })
            num = typeof y === 'number' ? y : null
            display = typeof y === 'number' && !Number.isInteger(y) && p.decimals == null ? y.toFixed(2) : String(y)
          } else if (parsed !== null) {
            display = String(parsed)
          }
        }
      }
      const key = `${instId}_${idx}`
      const prev = state.dashPrev[key]
      const flashClass = prev !== undefined && prev !== display ? ' flash' : ''
      state.dashPrev[key] = display

      html += `<div class="dash-card${flashClass}" data-key="${key}">
        <div class="dash-name">${escapeHtml(p.name)}</div>
        <div class="dash-value"><span class="dash-num">${escapeHtml(display)}</span>${p.unit ? `<span class="dash-unit">${escapeHtml(p.unit)}</span>` : ''}</div>
        ${p.unit === '%' && num !== null && num >= 0 && num <= 100 ? `<div class="dash-bar"><div style="width:${num}%"></div></div>` : ''}
      </div>`
    })
    if (html === '') html = '<div class="dev-empty">该类型无点位</div>'
    cardsContainer.innerHTML = html
  }

  // ── 实例启停 ──
  async function toggleInstance(id) {
    if (state.running[id]) {
      await window.api.deviceStop(id)
      state.running[id] = false
      state.statuses[id] = 'disconnected'
      renderDeviceArea()
      log('info', `设备「${state.instances.find(i => i.id === id)?.name || id}」已停止`)
      return
    }
    const inst = state.instances.find(i => i.id === id)
    if (!inst) return
    const cfg = buildInstanceCfg(inst)
    if (!cfg) { log('error', '设备类型未找到，请先配置类型'); return }
    try {
      await window.api.deviceStart({ id, cfg })
      state.running[id] = true
      state.statuses[id] = 'connected'
      renderDeviceArea()
      log('info', `设备「${inst.name}」已启动（${inst.host}:${inst.port}）`)
    } catch (err) {
      state.running[id] = false
      state.statuses[id] = 'error'
      renderDeviceArea()
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      log('error', `设备「${inst.name}」启动失败：${msg}`)
    }
  }

  // ── 事件处理 ──
  function onDeviceData(d) {
    state.data[d.id] = d.blocks
    renderInstanceCards(d.id)
  }

  function onDeviceStatus(s) {
    state.statuses[s.id] = s.state
    if (s.state === 'disconnected') state.running[s.id] = false
    // 更新左侧状态灯和组头状态
    const dot = document.querySelector(`.dev-inst-item[data-id="${s.id}"] .dot`)
    if (dot) dot.className = 'dot ' + s.state
    const group = document.querySelector(`.dev-group[data-inst-id="${s.id}"]`)
    if (group) {
      const gDot = group.querySelector('.dev-group-header .dot')
      if (gDot) gDot.className = 'dot ' + s.state
      group.classList.toggle('dev-group-offline', s.state === 'offline' || s.state === 'disconnected')
    }
  }

  function onDeviceLog(l) {
    const inst = state.instances.find(i => i.id === l.id)
    const prefix = inst ? `[${inst.name}]` : `[${l.id}]`
    log(l.level, `${prefix} ${l.message}`)
  }

  // ── 类型管理弹窗 ──
  function openTypeManager() {
    const overlay = $('typeManagerModal')
    overlay.classList.remove('hidden')
    renderTypeManager()
  }

  function renderTypeManager() {
    const list = $('typeList')
    if (!list) return
    list.innerHTML = ''
    state.types.forEach((t, idx) => {
      const div = document.createElement('div')
      div.className = 'type-mgr-row'
      div.innerHTML = `<span>${escapeHtml(t.name)}</span>
        <button class="type-edit-btn" data-idx="${idx}">编辑</button>
        <button class="type-del-btn" data-idx="${idx}">删除</button>`
      list.appendChild(div)
    })
    list.querySelectorAll('.type-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => editType(Number(btn.dataset.idx)))
    })
    list.querySelectorAll('.type-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('确定删除此类型？')) return
        state.types.splice(Number(btn.dataset.idx), 1)
        saveToConfig()
        renderTypeManager()
        renderDeviceArea()
      })
    })
    $('addTypeBtn').onclick = () => {
      state.types.push({ id: genId(), name: '新类型', points: [] })
      saveToConfig()
      renderTypeManager()
    }
  }

  function editType(idx) {
    const t = state.types[idx]
    if (!t) return
    $('typeMgrOverlay').classList.add('hidden')
    const overlay = $('typeEditorModal')
    overlay.classList.remove('hidden')
    $('typeEditorTitle').textContent = `编辑类型：${escapeHtml(t.name)}`
    $('typeNameInput').value = t.name
    renderTypePoints(t, idx)
    $('typeSaveBtn').onclick = () => {
      const name = $('typeNameInput').value.trim()
      if (!name) { $('typeEditorError').textContent = '类型名称不能为空'; return }
      t.name = name
      // 收集点位表
      const rows = $('typePointsTbody').querySelectorAll('tr')
      t.points = []
      let valid = true
      rows.forEach((tr, ri) => {
        const nameInput = tr.querySelector('.tp-name')
        const areaSel = tr.querySelector('.tp-area')
        const addrInput = tr.querySelector('.tp-addr')
        const typeSel = tr.querySelector('.tp-type')
        const orderSel = tr.querySelector('.tp-order')
        const kInput = tr.querySelector('.tp-k')
        const bInput = tr.querySelector('.tp-b')
        const decInput = tr.querySelector('.tp-dec')
        const unitInput = tr.querySelector('.tp-unit')
        if (!nameInput) return
        const pName = nameInput.value.trim()
        if (!pName) { $('typeEditorError').textContent = `第 ${ri + 1} 行：点位名称不能为空`; valid = false; return }
        const addr = Number(addrInput.value)
        if (!Number.isInteger(addr) || addr < 0 || addr > 65535) { $('typeEditorError').textContent = `第 ${ri + 1} 行：地址应为 0~65535 的整数`; valid = false; return }
        const k = Number(kInput.value)
        const b = Number(bInput.value)
        if (Number.isNaN(k) || Number.isNaN(b)) { $('typeEditorError').textContent = `第 ${ri + 1} 行：k 和 b 必须是数字`; valid = false; return }
        const decimals = decInput.value.trim() === '' ? null : Number(decInput.value)
        t.points.push({
          name: pName, area: areaSel.value, addr, type: typeSel.value,
          wordOrder: orderSel.value, k, b, decimals,
          unit: unitInput.value.trim(),
        })
      })
      if (!valid) return
      // 预演 ReadPlan，块数 >8 时提示
      const plan = ReadPlan.buildReadPlan(t.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) })))
      if (plan.length > 8) {
        if (!confirm(`点位过于分散，将产生 ${plan.length} 个读取块，可能影响采集效率。是否继续？`)) return
      }
      saveToConfig()
      closeTypeEditor()
      renderTypeManager()
      renderDeviceArea()
    }
  }

  function renderTypePoints(t, idx) {
    const tbody = $('typePointsTbody')
    tbody.innerHTML = ''
    if (t.points.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#999">暂无点位，点击下方添加</td></tr>'
    } else {
      t.points.forEach((p, pi) => {
        addPointRow(tbody, p, idx, pi)
      })
    }
    // 绑定添加点位按钮
    $('addPointBtn').onclick = () => {
      const t2 = state.types[idx]
      t2.points.push({ name: '', area: 'holding', addr: 0, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: null, unit: '' })
      renderTypePoints(t2, idx)
    }
  }

  function addPointRow(tbody, p, typeIdx, pointIdx) {
    const tr = document.createElement('tr')
    const areaOptions = ['holding', 'input', 'coil', 'discrete'].map(a =>
      `<option value="${a}" ${p.area === a ? 'selected' : ''}>${a === 'holding' ? '保持寄存器' : a === 'input' ? '输入寄存器' : a === 'coil' ? '线圈' : '离散输入'}</option>`).join('')
    const typeOptions = Object.entries(Codec.TYPES).map(([k, v]) =>
      `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.label}</option>`).join('')

    tr.innerHTML = `<td><input class="tp-name" value="${escapeHtml(p.name)}" placeholder="名称"></td>
      <td><select class="tp-area">${areaOptions}</select></td>
      <td><input class="tp-addr" type="number" value="${p.addr}" min="0" max="65535"></td>
      <td><select class="tp-type">${typeOptions}</select></td>
      <td><select class="tp-order"><option ${p.wordOrder === 'AB' ? 'selected' : ''}>AB</option><option ${p.wordOrder === 'BA' ? 'selected' : ''}>BA</option></select></td>
      <td><input class="tp-k" type="number" step="any" value="${p.k}" style="width:60px"></td>
      <td><input class="tp-b" type="number" step="any" value="${p.b}" style="width:60px"></td>
      <td><input class="tp-dec" type="number" min="0" max="6" value="${p.decimals ?? ''}" placeholder="自动" style="width:60px"></td>
      <td><input class="tp-unit" value="${escapeHtml(p.unit)}" placeholder="单位" style="width:50px"></td>
      <td><button class="tp-del-btn">×</button></td>`
    tr.querySelector('.tp-del-btn').addEventListener('click', () => {
      const t2 = state.types[typeIdx]
      t2.points.splice(pointIdx, 1)
      renderTypePoints(t2, typeIdx)
    })
    tbody.appendChild(tr)
  }

  function closeTypeEditor() {
    $('typeEditorModal').classList.add('hidden')
    $('typeEditorError').textContent = ''
    // 打开类型管理弹窗
    $('typeManagerModal').classList.remove('hidden')
  }

  // ── 实例管理弹窗 ──
  function openInstanceModal() {
    if (state.types.length === 0) {
      log('error', '请先创建设备类型')
      return
    }
    const overlay = $('instanceModal')
    overlay.classList.remove('hidden')
    // 填充类型下拉
    const sel = $('instTypeSel')
    sel.innerHTML = state.types.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
    $('instName').value = ''
    $('instHost').value = '192.168.1.'
    $('instPort').value = 502
    $('instUnitId').value = 1
    $('instInterval').value = 1000
    $('instModalError').textContent = ''
    $('instModalOk').onclick = async () => {
      const name = $('instName').value.trim()
      const host = $('instHost').value.trim()
      const port = Number($('instPort').value)
      const unitId = Number($('instUnitId').value)
      const interval = Number($('instInterval').value)
      const typeId = $('instTypeSel').value
      if (!name) { $('instModalError').textContent = '请输入实例名称'; return }
      if (!host) { $('instModalError').textContent = '请输入设备 IP'; return }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { $('instModalError').textContent = '端口范围 1~65535'; return }
      if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) { $('instModalError').textContent = '从站 ID 范围 0~255'; return }
      if (![100, 500, 1000, 2000, 5000, 10000].includes(interval)) { $('instModalError').textContent = '周期值无效'; return }
      state.instances.push({ id: genId(), typeId, name, host, port, unitId, interval })
      await saveToConfig()
      closeInstanceModal()
      renderDeviceArea()
      log('info', `已添加设备实例「${name}」`)
    }
  }

  function closeInstanceModal() {
    $('instanceModal').classList.add('hidden')
  }

  // ── 初始化 ──
  function init() {
    // 注册 IPC 监听
    window.api.onDeviceData(onDeviceData)
    window.api.onDeviceStatus(onDeviceStatus)
    window.api.onDeviceLog(onDeviceLog)
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  return {
    init,
    loadFromConfig,
    renderDeviceArea,
    renderInstanceCards,
  }
})()
