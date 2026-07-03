// renderer/device.js — 设备模式：类型/实例管理 + 设备总览分组仪表盘 + 设备调试点位表
// 依赖全局 Codec、ReadPlan、window.api；在 app.js 前加载
const DeviceUI = (() => {
  const $ = id => document.getElementById(id)

  // ── 数据状态 ──
  const state = {
    types: [],        // [{ id, name, points: [...] }]
    instances: [],    // [{ id, typeId, name, host, port, unitId, interval, imagePath }]
    running: {},      // id → true/false
    data: {},         // id → blocks（最新采集数据）
    statuses: {},     // id → 'connected'|'offline'|'disconnected'|'error'
    dashPrev: {},     // id → pointKey → prevDisplay
  }

  // ── 工具 ──
  let nextId = 1
  function genId() { return `dev${nextId++}` }

  // ── 裁剪状态（app.js 通过 DeviceUI.cropState 读写）──
  const cropState = { imgX: 0, imgY: 0, outputSize: 128, pendingImagePath: '' }

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
    try {
      const cfg = await window.api.loadConfig()
      await window.api.saveConfig({ ...cfg, deviceTypes: state.types, deviceInstances: state.instances })
    } catch (e) {
      console.error('saveToConfig 失败', e)
      alert('保存配置失败: ' + (e.message || e))
    }
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
    if (state.instances.length === 0) {
      content.innerHTML = '<div class="dev-empty-page"><p>暂无设备实例</p><button class="btn" id="ovFirstAddBtn2">＋ 添加第一台设备</button></div>'
      const btn = content.querySelector('#ovFirstAddBtn2')
      if (btn) btn.addEventListener('click', () => {
        if (state.types.length === 0) { log('error', '请先在「类型/实例管理」页创建设备类型'); switchToMgrPage(); return }
        openInstanceModal()
      })
      return
    }
    let html = ''
    state.instances.forEach(inst => {
      const type = state.types.find(t => t.id === inst.typeId)
      const running = state.running[inst.id]
      const status = state.statuses[inst.id] || 'disconnected'
      const offline = !running || status === 'offline' || status === 'disconnected' || status === 'error'
      const statusDot = !running ? 'idle' : status === 'connected' ? 'good' : status === 'offline' ? 'warn' : 'crit'
      const statusText = !running ? '已停止' : status === 'connected' ? '在线' : status === 'offline' ? '离线·重连中' : '连接失败'
      const thumbHtml = inst.imagePath
        ? `<img class="dev-thumb-img" data-path="${escapeHtml(inst.imagePath)}">`
        : `<span class="dev-thumb-placeholder">No img</span>`
      html += `<section class="dev-group ${offline ? 'offline' : ''}" data-inst-id="${inst.id}">
        <div class="dev-head">
          <span class="collapse-toggle" data-inst-id="${inst.id}">▾</span>
          ${thumbHtml}
          <span class="dev-name">${escapeHtml(inst.name)}</span>
          <span class="dev-meta">${escapeHtml(inst.host)}:${inst.port} · 从站${inst.unitId} · 周期 ${inst.interval}ms</span>
          <span class="pill"><span class="dot ${statusDot}"></span>${statusText}</span>
          <button class="btn ghost sm dev-toggle-ov" data-id="${inst.id}">${running ? '⏸ 停止' : '▶ 启动'}</button>
        </div>
        <div class="dev-body" id="ovBody_${inst.id}"></div>
      </section>`
    })
    content.innerHTML = html
    // 绑定折叠切换
    content.querySelectorAll('.collapse-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const section = el.closest('.dev-group')
        section.classList.toggle('collapsed')
        el.textContent = section.classList.contains('collapsed') ? '▸' : '▾'
      })
    })
    // 绑定启停
    content.querySelectorAll('.dev-toggle-ov').forEach(btn => {
      btn.addEventListener('click', () => toggleInstance(btn.dataset.id))
    })
    // 异步加载设备图片缩略图
    content.querySelectorAll('.dev-thumb-img').forEach(img => {
      const path = img.dataset.path
      if (path) {
        window.api.readImage(path).then(dataUrl => { img.src = dataUrl }).catch(() => {})
      }
    })
    // 渲染每设备卡片（仅运行中实例有数据）
    state.instances.filter(inst => state.running[inst.id]).forEach(inst => renderInstanceCards(inst.id))
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
            <button class="btn ghost sm mgr-edit-type" data-idx="${idx}">编辑</button>
            <button class="btn ghost sm mgr-del-type" style="border-color:var(--status-critical);color:var(--status-critical)" data-idx="${idx}">删除</button>
          </div>`).join('')
        // 直接绑定类型编辑/删除
        typeList.querySelectorAll('.mgr-edit-type').forEach(btn => btn.onclick = () => openTypeEditor(Number(btn.dataset.idx)))
        typeList.querySelectorAll('.mgr-del-type').forEach(btn => btn.onclick = () => deleteType(Number(btn.dataset.idx)))
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
            <button class="btn ghost sm mgr-toggle-inst" data-id="${inst.id}">${running ? '停止' : '启动'}</button>
            <button class="btn ghost sm mgr-edit-inst" data-id="${inst.id}">编辑</button>
            <button class="btn ghost sm mgr-del-inst" style="border-color:var(--status-critical);color:var(--status-critical)" data-id="${inst.id}">删除</button>
          </div>`
        }).join('')
        // 直接绑定实例启停/编辑/删除
        instList.querySelectorAll('.mgr-toggle-inst').forEach(btn => btn.onclick = () => toggleInstance(btn.dataset.id))
        instList.querySelectorAll('.mgr-edit-inst').forEach(btn => btn.onclick = () => editInstance(btn.dataset.id))
        instList.querySelectorAll('.mgr-del-inst').forEach(btn => btn.onclick = () => deleteInstance(btn.dataset.id))
      }
    }
  }

  // ── 类型/实例 CRUD ──
  async function deleteType(idx) {
    const t = state.types[idx]
    if (!t) return
    const used = state.instances.some(inst => inst.typeId === t.id)
    if (used) { alert(`类型「${t.name}」已被实例引用，请先删除相关实例`); return }
    if (!confirm(`确定删除类型「${t.name}」？`)) return
    state.types.splice(idx, 1)
    await saveToConfig(); renderMgrPage(); renderOverviewPage()
  }

  async function deleteInstance(id) {
    try {
      const inst = state.instances.find(i => i.id === id)
      if (!inst) { alert(`未找到实例 (${id})，请刷新页面重试`); return }
      if (state.running[id]) { alert('请先停止设备再删除'); return }
      if (!confirm(`确定删除实例「${inst.name}」？`)) return
      // 如有设备管理器实例，停止轮询
      if (window._appStopInstance) window._appStopInstance(id)
      state.instances = state.instances.filter(i => i.id !== id)
      delete state.running[id]; delete state.statuses[id]; delete state.data[id]
      await saveToConfig(); renderMgrPage(); renderOverviewPage()
    } catch (e) {
      console.error('deleteInstance 异常', e)
      alert('删除失败: ' + (e.message || e))
    }
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
    cropState.pendingImagePath = ''
    const overlay = $('instanceModal'); overlay.classList.remove('hidden')
    const sel = $('instTypeSel')
    sel.innerHTML = state.types.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
    $('instName').value = ''; $('instHost').value = '192.168.1.'
    $('instPort').value = 502; $('instUnitId').value = 1; $('instInterval').value = 1000
    $('instModalError').textContent = ''
    $('instModalTitle').textContent = '添加设备实例'
    // 图片预览行隐藏
    $('instImagePreviewRow').style.display = 'none'
    $('instImagePreview').src = ''
    $('instImageInput').value = ''
    // 图片选择（用共享处理器）
    $('instImageInput').onchange = () => handleImageSelection()
    $('instModalOk').onclick = async () => {
      const name = $('instName').value.trim(); const host = $('instHost').value.trim()
      const port = Number($('instPort').value); const unitId = Number($('instUnitId').value)
      const interval = Number($('instInterval').value); const typeId = $('instTypeSel').value
      if (!name) { $('instModalError').textContent = '请输入实例名称'; return }
      if (!host) { $('instModalError').textContent = '请输入设备 IP'; return }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { $('instModalError').textContent = '端口范围 1~65535'; return }
      if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) { $('instModalError').textContent = '从站 ID 范围 0~255'; return }
      if (![100, 500, 1000, 2000, 5000, 10000].includes(interval)) { $('instModalError').textContent = '周期值无效'; return }
      state.instances.push({ id: genId(), typeId, name, host, port, unitId, interval, imagePath: cropState.pendingImagePath })
      await saveToConfig(); closeInstanceModal(); renderMgrPage(); renderOverviewPage()
      log('info', `已添加设备实例「${name}」`)
      // 跳转到管理页让用户看到实例
      window.switchNav('mgr')
      // 刷新设备调试下拉
      if (window.populateDeviceDebugSel) window.populateDeviceDebugSel()
    }
  }

  function closeInstanceModal() { $('instanceModal').classList.add('hidden') }

  // ── 编辑实例（复用弹窗） ──
  function editInstance(id) {
    const inst = state.instances.find(i => i.id === id)
    if (!inst) { alert('未找到实例'); return }
    if (state.running[id]) { alert('请先停止设备再编辑'); return }
    cropState.pendingImagePath = ''
    const overlay = $('instanceModal'); overlay.classList.remove('hidden')
    const sel = $('instTypeSel')
    sel.innerHTML = state.types.map(t => `<option value="${t.id}" ${t.id === inst.typeId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')
    $('instName').value = inst.name
    $('instHost').value = inst.host
    $('instPort').value = inst.port
    $('instUnitId').value = inst.unitId
    $('instInterval').value = inst.interval
    $('instModalError').textContent = ''
    $('instModalTitle').textContent = '编辑设备实例'
    // 图片：如有则显示预览
    if (inst.imagePath) {
      $('instImagePreviewRow').style.display = ''
      window.api.readImage(inst.imagePath).then(url => { $('instImagePreview').src = url }).catch(() => { $('instImagePreview').src = '' })
    } else {
      $('instImagePreviewRow').style.display = 'none'
      $('instImagePreview').src = ''
    }
    $('instImageInput').value = ''
    // 图片选择（用共享处理器）
    $('instImageInput').onchange = () => handleImageSelection()
    $('instModalOk').onclick = async () => {
      const name = $('instName').value.trim(); const host = $('instHost').value.trim()
      const port = Number($('instPort').value); const unitId = Number($('instUnitId').value)
      const interval = Number($('instInterval').value); const typeId = $('instTypeSel').value
      if (!name) { $('instModalError').textContent = '请输入实例名称'; return }
      if (!host) { $('instModalError').textContent = '请输入设备 IP'; return }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { $('instModalError').textContent = '端口范围 1~65535'; return }
      if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) { $('instModalError').textContent = '从站 ID 范围 0~255'; return }
      if (![100, 500, 1000, 2000, 5000, 10000].includes(interval)) { $('instModalError').textContent = '周期值无效'; return }
      Object.assign(inst, { typeId, name, host, port, unitId, interval })
      if (cropState.pendingImagePath) inst.imagePath = cropState.pendingImagePath
      await saveToConfig(); closeInstanceModal(); renderMgrPage(); renderOverviewPage()
      log('info', `已更新设备实例「${name}」`)
      if (window.populateDeviceDebugSel) window.populateDeviceDebugSel()
    }
  }

  // ── 图片选择：类型/大小过滤 → 若需要则裁剪 ──
  function handleImageSelection() {
    const file = $('instImageInput').files[0]
    if (!file) return
    const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    if (!ALLOWED.includes(file.type)) { alert('仅支持 PNG/JPEG/GIF/WebP 格式'); $('instImageInput').value = ''; return }
    if (file.size > 5 * 1024 * 1024) { alert('图片超过 5MB，请选择更小的图片'); $('instImageInput').value = ''; return }
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target.result
      const img = new Image()
      img.onload = () => {
        if (img.width > 200 || img.height > 200) {
          openCropModal(dataUrl)
        } else {
          // 小图直接保存
          window.api.saveImage(dataUrl).then(path => {
            cropState.pendingImagePath = path
            $('instImagePreview').src = dataUrl
            $('instImagePreviewRow').style.display = ''
          }).catch(() => { alert('图片保存失败') })
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  function openCropModal(dataUrl) {
    cropState.outputSize = 128
    cropState.imgX = 0; cropState.imgY = 0
    const modal = $('cropModal'); modal.classList.remove('hidden')
    const img = $('cropImage'); const container = $('cropContainer')
    $('cropError').textContent = ''
    document.querySelectorAll('.crop-size-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.size) === 128))
    img.onload = () => {
      const scale = Math.max(container.clientWidth / img.naturalWidth, container.clientHeight / img.naturalHeight)
      img.width = Math.round(img.naturalWidth * scale)
      img.height = Math.round(img.naturalHeight * scale)
      cropState.imgX = Math.round((container.clientWidth - img.width) / 2)
      cropState.imgY = Math.round((container.clientHeight - img.height) / 2)
      updateCropDisplay()
    }
    img.src = dataUrl
  }

  function updateCropDisplay() {
    const img = $('cropImage'); img.style.left = cropState.imgX + 'px'; img.style.top = cropState.imgY + 'px'
    const container = $('cropContainer')
    // 固定中心 1:1 正方形裁剪框
    const side = Math.min(container.clientWidth - 4, container.clientHeight - 4)
    const cx = Math.round((container.clientWidth - side) / 2)
    const cy = Math.round((container.clientHeight - side) / 2)
    const overlay = $('cropOverlay')
    overlay.style.left = cx + 'px'; overlay.style.top = cy + 'px'
    overlay.style.width = side + 'px'; overlay.style.height = side + 'px'
    // 存储裁切信息供确认时使用
    const imgLeft = cropState.imgX, imgTop = cropState.imgY
    const imgRight = imgLeft + $('cropImage').width, imgBottom = imgTop + $('cropImage').height
    // 实际可见裁切区域（约束在图片可见范围内）
    const vLeft = Math.max(cx, imgLeft), vTop = Math.max(cy, imgTop)
    const vRight = Math.min(cx + side, imgRight), vBottom = Math.min(cy + side, imgBottom)
    const vSide = Math.round(Math.min(vRight - vLeft, vBottom - vTop))
    if (vSide > 0) {
      overlay._cropInfo = { imgX: vLeft - imgLeft, imgY: vTop - imgTop, side: vSide }
    } else {
      overlay._cropInfo = { imgX: 0, imgY: 0, side: 1 }
    }
  }

  function closeCropModal() { $('cropModal').classList.add('hidden'); $('cropImage').src = '' }

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
    // 裁剪状态引用（app.js 通过 DeviceUI.cropState 读写）
    cropState,
    updateCropDisplay,
    closeCropModal,
    openCropModal,
    handleImageSelection,
  }
})()
window.DeviceUI = DeviceUI
