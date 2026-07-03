// renderer/device.js — 设备模式：类型/实例管理 + 设备总览分组仪表盘 + 设备调试点位表
// 依赖全局 Codec、ReadPlan、window.api；在 app.js 前加载
const DeviceUI = (() => {
  const $ = id => document.getElementById(id)

  // ── 数据状态 ──
  const state = {
    types: [],        // [{ id, name, points: [...] }]
    instances: [],    // [{ id, typeId, name, host, port, unitId, interval }]
    running: {},      // id → true/false
    data: {},         // id → blocks（最新采集数据）
    statuses: {},     // id → 'connected'|'offline'|'disconnected'|'error'
    dashPrev: {},     // id → pointKey → prevDisplay
  }

  // ── 工具 ──
  let nextId = 1
  function genId() { return `dev${nextId++}` }

  function getWords(area, type) {
    if (area === 'coil' || area === 'discrete') return 1
    return Codec.TYPES[type] ? Codec.TYPES[type].words : 1
  }

  function buildInstanceCfg(inst) {
    const type = state.types.find(t => t.id === inst.typeId)
    if (!type) return null
    return {
      host: inst.host, port: inst.port, unitId: inst.unitId, interval: inst.interval,
      blocks: ReadPlan.buildReadPlan(
        type.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) }))
      ),
    }
  }

  function loadFromConfig(cfg) {
    if (Array.isArray(cfg.deviceTypes)) state.types = cfg.deviceTypes
    if (Array.isArray(cfg.deviceInstances)) state.instances = cfg.deviceInstances
    state.instances.forEach(inst => {
      const n = parseInt(inst.id.replace('dev', ''))
      if (n >= nextId) nextId = n + 1
    })
  }

  async function saveToConfig() {
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, deviceTypes: state.types, deviceInstances: state.instances })
  }

  function log(level, message) {
    if (window._appLogFn) window._appLogFn(level, message)
    else console[level](message)
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  // ── 实例启停 ──
  async function toggleInstance(id) {
    if (state.running[id]) {
      await window.api.deviceStop(id)
      state.running[id] = false; state.statuses[id] = 'disconnected'
      renderOverviewPage(); renderMgrPage()
      log('info', `设备「${state.instances.find(i => i.id === id)?.name || id}」已停止`)
      return
    }
    const inst = state.instances.find(i => i.id === id)
    if (!inst) return
    const cfg = buildInstanceCfg(inst)
    if (!cfg) { log('error', '设备类型未找到，请先配置类型'); return }
    try {
      await window.api.deviceStart({ id, cfg })
      state.running[id] = true; state.statuses[id] = 'connected'
      renderOverviewPage(); renderMgrPage()
      log('info', `设备「${inst.name}」已启动（${inst.host}:${inst.port}）`)
    } catch (err) {
      state.running[id] = false; state.statuses[id] = 'error'
      renderOverviewPage(); renderMgrPage()
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
    // 更新总览页状态
    const group = document.querySelector(`.dev-group[data-inst-id="${s.id}"]`)
    if (group) {
      const dot = group.querySelector('.dev-head .dot')
      if (dot) dot.className = 'dot ' + (s.state === 'connected' ? 'good' : s.state === 'offline' ? 'warn' : s.state === 'error' ? 'crit' : 'idle')
      const pill = group.querySelector('.dev-head .pill .dot')
      if (pill) pill.className = 'dot ' + (s.state === 'connected' ? 'good' : s.state === 'offline' ? 'warn' : s.state === 'error' ? 'crit' : 'idle')
      group.classList.toggle('offline', s.state === 'offline' || s.state === 'disconnected' || s.state === 'error')
    }
    // 更新总览页右上角在线/离线计数
    if (window.updateOnlineOfflinePills) window.updateOnlineOfflinePills()
  }

  function onDeviceLog(l) {
    const inst = state.instances.find(i => i.id === l.id)
    const prefix = inst ? `[${inst.name}]` : `[${l.id}]`
    log(l.level, `${prefix} ${l.message}`)
  }

  // ── 设备总览页：分组仪表盘（页面 #devOverviewPage） ──
  function renderOverviewPage() {
    const content = $('ovContent')
    if (!content) return
    const activeInsts = state.instances.filter(inst => state.running[inst.id])
    if (state.instances.length === 0) {
      content.innerHTML = '<div class="dev-empty-page"><p>暂无设备实例</p><button class="btn" id="ovFirstAddBtn2">＋ 添加第一台设备</button></div>'
      const btn = content.querySelector('#ovFirstAddBtn2')
      if (btn) btn.addEventListener('click', () => {
        if (state.types.length === 0) { log('error', '请先在「类型/实例管理」页创建设备类型'); switchToMgrPage(); return }
        openInstanceModal()
      })
      return
    }
    if (activeInsts.length === 0) {
      content.innerHTML = '<div class="dev-empty-page"><p>所有设备已停止</p><p style="font-size:12px">在左侧实例列表点击「启动」开始采集</p></div>'
      return
    }
    let html = ''
    activeInsts.forEach(inst => {
      const type = state.types.find(t => t.id === inst.typeId)
      const status = state.statuses[inst.id] || 'disconnected'
      const offline = status === 'offline' || status === 'disconnected' || status === 'error'
      const statusDot = status === 'connected' ? 'good' : status === 'offline' ? 'warn' : status === 'error' ? 'crit' : 'idle'
      const statusText = status === 'connected' ? '在线' : status === 'offline' ? '离线·重连中' : status === 'error' ? '连接失败' : '未启动'
      html += `<section class="dev-group ${offline ? 'offline' : ''}" data-inst-id="${inst.id}">
        <div class="dev-head">
          <span class="dev-name">${escapeHtml(inst.name)}</span>
          <span class="dev-meta">${escapeHtml(inst.host)}:${inst.port} · 从站${inst.unitId} · 周期 ${inst.interval}ms</span>
          <span class="pill"><span class="dot ${statusDot}"></span>${statusText}</span>
          <button class="btn ghost sm dev-toggle-ov" data-id="${inst.id}">${offline ? '▶ 启动' : '⏸ 停止'}</button>
        </div>
        <div class="dev-body" id="ovBody_${inst.id}"></div>
      </section>`
    })
    content.innerHTML = html
    // 绑定启停
    content.querySelectorAll('.dev-toggle-ov').forEach(btn => {
      btn.addEventListener('click', () => toggleInstance(btn.dataset.id))
    })
    // 渲染每设备卡片
    activeInsts.forEach(inst => renderInstanceCards(inst.id))
    // 更新在线/离线计数
    if (window.updateOnlineOfflinePills) window.updateOnlineOfflinePills()
  }

  // ── 渲染某实例的 tile 卡片（供 onDeviceData 调用刷新）──
  function renderInstanceCards(instId) {
    const body = $('ovBody_' + instId)
    if (!body) return
    const inst = state.instances.find(i => i.id === instId)
    const type = state.types.find(t => t.id === inst?.typeId)
    const blocks = state.data[instId]
    if (!inst || !type || !blocks) { body.innerHTML = ''; return }
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
      html += `<div class="tile${flashClass}" data-key="${key}">
        <div class="tile-name">${escapeHtml(p.name)}</div>
        <div class="tile-value"><span class="tile-num">${escapeHtml(display)}</span>${p.unit ? `<span class="tile-unit">${escapeHtml(p.unit)}</span>` : ''}</div>
        ${p.unit === '%' && num !== null && num >= 0 && num <= 100 ? `<div class="tile-bar"><i style="width:${num}%"></i></div>` : ''}
      </div>`
    })
    if (html === '') html = '<div class="dev-empty-page"><p>该类型无点位</p></div>'
    body.innerHTML = html
  }

  // ── 类型/实例管理页（页面 #mgrPage） ──
  function renderMgrPage() {
    // 类型列表
    const typeList = $('mgrTypeList')
    if (typeList) {
      if (state.types.length === 0) {
        typeList.innerHTML = '<div class="mgr-empty">暂无类型，点击上方「新建类型」创建</div>'
      } else {
        typeList.innerHTML = state.types.map((t, idx) => `
          <div class="mgr-row">
            <span class="mgr-name">${escapeHtml(t.name)}</span>
            <span class="mgr-meta">${t.points.length} 个点位</span>
            <button class="btn ghost sm" onclick="DeviceUI.openTypeEditor(${idx})">编辑</button>
            <button class="btn ghost sm" style="border-color:var(--status-critical);color:var(--status-critical)" onclick="DeviceUI.deleteType(${idx})">删除</button>
          </div>`).join('')
      }
    }
    // 实例列表
    const instList = $('mgrInstList')
    if (instList) {
      if (state.instances.length === 0) {
        instList.innerHTML = '<div class="mgr-empty">暂无实例，点击上方「添加设备」创建</div>'
      } else {
        instList.innerHTML = state.instances.map(inst => {
          const type = state.types.find(t => t.id === inst.typeId)
          const running = state.running[inst.id]
          const status = state.statuses[inst.id] || 'disconnected'
          const dotCls = status === 'connected' ? 'good' : status === 'offline' ? 'warn' : status === 'error' ? 'crit' : 'idle'
          return `<div class="mgr-row">
            <span class="dot ${dotCls}"></span>
            <span class="mgr-name">${escapeHtml(inst.name)}</span>
            <span class="mgr-meta">${type ? escapeHtml(type.name) : '（未知）'} · ${escapeHtml(inst.host)}:${inst.port} · ${running ? '运行中' : '已停止'}</span>
            <button class="btn ghost sm" onclick="DeviceUI.toggleInstance('${inst.id}')">${running ? '停止' : '启动'}</button>
            <button class="btn ghost sm" style="border-color:var(--status-critical);color:var(--status-critical)" onclick="DeviceUI.deleteInstance('${inst.id}')">删除</button>
          </div>`
        }).join('')
      }
    }
  }

  // ── 类型/实例 CRUD ──
  function deleteType(idx) {
    const t = state.types[idx]
    if (!t) return
    const used = state.instances.some(inst => inst.typeId === t.id)
    if (used) { log('error', `类型「${t.name}」已被实例引用，请先删除相关实例`); return }
    if (!confirm(`确定删除类型「${t.name}」？`)) return
    state.types.splice(idx, 1)
    saveToConfig(); renderMgrPage(); renderOverviewPage()
  }

  function deleteInstance(id) {
    const inst = state.instances.find(i => i.id === id)
    if (!inst) return
    if (state.running[id]) { log('error', '请先停止设备再删除'); return }
    if (!confirm(`确定删除实例「${inst.name}」？`)) return
    state.instances = state.instances.filter(i => i.id !== id)
    delete state.running[id]; delete state.statuses[id]; delete state.data[id]
    saveToConfig(); renderMgrPage(); renderOverviewPage()
  }

  function openTypeEditor(idx) {
    const t = state.types[idx]
    if (!t) return
    $('typeEditorTitle').textContent = `编辑类型：${escapeHtml(t.name)}`
    $('typeNameInput').value = t.name
    renderTypePoints(t, idx)
    $('typeSaveBtn').onclick = () => {
      const name = $('typeNameInput').value.trim()
      if (!name) { $('typeEditorError').textContent = '类型名称不能为空'; return }
      t.name = name
      const rows = $('typePointsTbody').querySelectorAll('tr')
      t.points = []; let valid = true
      rows.forEach((tr, ri) => {
        const nameInput = tr.querySelector('.tp-name'); const areaSel = tr.querySelector('.tp-area')
        const addrInput = tr.querySelector('.tp-addr'); const typeSel = tr.querySelector('.tp-type')
        const orderSel = tr.querySelector('.tp-order'); const kInput = tr.querySelector('.tp-k')
        const bInput = tr.querySelector('.tp-b'); const decInput = tr.querySelector('.tp-dec'); const unitInput = tr.querySelector('.tp-unit')
        if (!nameInput) return
        const pName = nameInput.value.trim()
        if (!pName) { $('typeEditorError').textContent = `第 ${ri + 1} 行：点位名称不能为空`; valid = false; return }
        const addr = Number(addrInput.value)
        if (!Number.isInteger(addr) || addr < 0 || addr > 65535) { $('typeEditorError').textContent = `第 ${ri + 1} 行：地址应为 0~65535 的整数`; valid = false; return }
        const k = Number(kInput.value); const b = Number(bInput.value)
        if (Number.isNaN(k) || Number.isNaN(b)) { $('typeEditorError').textContent = `第 ${ri + 1} 行：k 和 b 必须是数字`; valid = false; return }
        t.points.push({ name: pName, area: areaSel.value, addr, type: typeSel.value, wordOrder: orderSel.value, k, b, decimals: decInput.value.trim() === '' ? null : Number(decInput.value), unit: unitInput.value.trim() })
      })
      if (!valid) return
      const plan = ReadPlan.buildReadPlan(t.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) })))
      if (plan.length > 8) { if (!confirm(`点位过于分散，将产生 ${plan.length} 个读取块，可能影响采集效率。是否继续？`)) return }
      saveToConfig(); closeTypeEditor(); renderMgrPage(); renderOverviewPage()
    }
    $('typeEditorModal').classList.remove('hidden')
  }

  function openTypeEditorForNew() {
    const t = { id: genId(), name: '新类型', points: [] }
    state.types.push(t)
    $('typeEditorTitle').textContent = '新建类型'
    $('typeNameInput').value = t.name
    renderTypePoints(t, state.types.length - 1)
    $('typeSaveBtn').onclick = () => {
      const name = $('typeNameInput').value.trim()
      if (!name) { $('typeEditorError').textContent = '类型名称不能为空'; return }
      t.name = name
      const rows = $('typePointsTbody').querySelectorAll('tr')
      t.points = []; let valid = true
      rows.forEach((tr, ri) => {
        // same collection logic as openTypeEditor
        const nameInput = tr.querySelector('.tp-name'); const areaSel = tr.querySelector('.tp-area')
        const addrInput = tr.querySelector('.tp-addr'); const typeSel = tr.querySelector('.tp-type')
        const orderSel = tr.querySelector('.tp-order'); const kInput = tr.querySelector('.tp-k')
        const bInput = tr.querySelector('.tp-b'); const decInput = tr.querySelector('.tp-dec'); const unitInput = tr.querySelector('.tp-unit')
        if (!nameInput) return
        const pName = nameInput.value.trim()
        if (!pName) { $('typeEditorError').textContent = `第 ${ri + 1} 行：点位名称不能为空`; valid = false; return }
        const addr = Number(addrInput.value)
        if (!Number.isInteger(addr) || addr < 0 || addr > 65535) { $('typeEditorError').textContent = `第 ${ri + 1} 行：地址应为 0~65535 的整数`; valid = false; return }
        const k = Number(kInput.value); const b = Number(bInput.value)
        if (Number.isNaN(k) || Number.isNaN(b)) { $('typeEditorError').textContent = `第 ${ri + 1} 行：k 和 b 必须是数字`; valid = false; return }
        t.points.push({ name: pName, area: areaSel.value, addr, type: typeSel.value, wordOrder: orderSel.value, k, b, decimals: decInput.value.trim() === '' ? null : Number(decInput.value), unit: unitInput.value.trim() })
      })
      if (!valid) return
      const plan = ReadPlan.buildReadPlan(t.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) })))
      if (plan.length > 8) { if (!confirm(`点位过于分散，将产生 ${plan.length} 个读取块，可能影响采集效率。是否继续？`)) return }
      saveToConfig(); closeTypeEditor(); renderMgrPage(); renderOverviewPage()
    }
    $('typeEditorModal').classList.remove('hidden')
  }

  // ── 类型点位编辑表格（复用 v0.2 逻辑） ──
  function renderTypePoints(t, idx) {
    const tbody = $('typePointsTbody'); tbody.innerHTML = ''
    if (t.points.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--ink-3)">暂无点位，点击下方添加</td></tr>'
    } else {
      t.points.forEach((p, pi) => addPointRow(tbody, p, idx, pi))
    }
    $('addPointBtn').onclick = () => {
      state.types[idx].points.push({ name: '', area: 'holding', addr: 0, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: null, unit: '' })
      renderTypePoints(state.types[idx], idx)
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
      state.types[typeIdx].points.splice(pointIdx, 1)
      renderTypePoints(state.types[typeIdx], typeIdx)
    })
    tbody.appendChild(tr)
  }

  function closeTypeEditor() {
    $('typeEditorModal').classList.add('hidden')
    $('typeEditorError').textContent = ''
  }

  // ── 实例管理弹窗 ──
  function openInstanceModal() {
    if (state.types.length === 0) { log('error', '请先创建设备类型'); return }
    const overlay = $('instanceModal'); overlay.classList.remove('hidden')
    const sel = $('instTypeSel')
    sel.innerHTML = state.types.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
    $('instName').value = ''; $('instHost').value = '192.168.1.'
    $('instPort').value = 502; $('instUnitId').value = 1; $('instInterval').value = 1000
    $('instModalError').textContent = ''
    $('instModalOk').onclick = async () => {
      const name = $('instName').value.trim(); const host = $('instHost').value.trim()
      const port = Number($('instPort').value); const unitId = Number($('instUnitId').value)
      const interval = Number($('instInterval').value); const typeId = $('instTypeSel').value
      if (!name) { $('instModalError').textContent = '请输入实例名称'; return }
      if (!host) { $('instModalError').textContent = '请输入设备 IP'; return }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { $('instModalError').textContent = '端口范围 1~65535'; return }
      if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) { $('instModalError').textContent = '从站 ID 范围 0~255'; return }
      if (![100, 500, 1000, 2000, 5000, 10000].includes(interval)) { $('instModalError').textContent = '周期值无效'; return }
      state.instances.push({ id: genId(), typeId, name, host, port, unitId, interval })
      await saveToConfig(); closeInstanceModal(); renderMgrPage(); renderOverviewPage()
      log('info', `已添加设备实例「${name}」`)
      // 跳转到管理页让用户看到实例
      switchNav('mgrPage')
      // 刷新设备调试下拉
      if (window.populateDeviceDebugSel) window.populateDeviceDebugSel()
    }
  }

  function closeInstanceModal() { $('instanceModal').classList.add('hidden') }

  // ── 初始化（IPC 监听）──
  function init() {
    window.api.onDeviceData(onDeviceData)
    window.api.onDeviceStatus(onDeviceStatus)
    window.api.onDeviceLog(onDeviceLog)
  }

  function switchToMgrPage() {
    // 切换到类型/实例管理页
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === 'mgrPage'))
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'mgrPage'))
  }

  return {
    state,
    init,
    loadFromConfig,
    getWords,
    toggleInstance,
    renderOverviewPage,
    renderInstanceCards,
    renderMgrPage,
    openInstanceModal,
    openTypeEditor,
    openTypeEditorForNew,
    deleteType,
    deleteInstance,
  }
})()
