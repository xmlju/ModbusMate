// renderer/device.js — 设备模式：类型/实例管理 + 设备总览分组仪表盘 + 设备调试点位表
// 依赖全局 Codec、ReadPlan、ConnectionUI、DeviceConfig、window.api；在 app.js 前加载
const DeviceUI = (() => {
  const $ = id => document.getElementById(id)

  // ── 数据状态 ──
  const state = {
    types: [],        // [{ id, name, points: [...] }]
    instances: [],    // [{ id, typeId, name, transport, ...连接参数, interval, iconIdx }]
    running: {},      // id → true/false
    data: {},         // id → blocks（最新采集数据）
    skipped: {},      // id → 本轮被跳过的读取块（设备当前模式下不可读的地址）
    statuses: {},     // id → 'connected'|'offline'|'disconnected'|'error'
    dashPrev: {},     // id → pointKey → prevDisplay
  }

  // ── 工具 ──
  let nextId = 1
  function genId() { return `dev${nextId++}` }

  // ── 预设设备图标（base64 SVG data URI, 32x32）──
  // 用 base64 彻底避免 # → %23 编码问题
  function _b64svg(svg) { return 'data:image/svg+xml;base64,' + btoa(svg) }
  const PRESET_ICONS = [
    // 0: 电池柜
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="8" y="4" width="16" height="24" rx="2" fill="none" stroke="#3987e5" stroke-width="2"/><rect x="12" y="8" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="17" y="8" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="12" y="16" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="17" y="16" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="13" y="2" width="6" height="3" rx="1" fill="#3987e5"/></svg>'),
    // 1: PLC 控制器
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="8" y="10" width="5" height="5" rx="1" fill="#0ca30c"/><rect x="8" y="18" width="5" height="5" rx="1" fill="#fab219"/><rect x="16" y="10" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="14" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="18" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="22" width="8" height="2" rx="1" fill="#c3c2b7"/></svg>'),
    // 2: 温控器
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="13" y="2" width="6" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><circle cx="16" cy="25" r="5" fill="none" stroke="#d03b3b" stroke-width="1.8"/><circle cx="16" cy="25" r="2.5" fill="#d03b3b"/><rect x="10" y="12" width="12" height="2" rx="1" fill="#c3c2b7"/><rect x="10" y="16" width="8" height="2" rx="1" fill="#c3c2b7"/></svg>'),
    // 3: 服务器
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="3" width="20" height="26" rx="2" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="9" y="6" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="8" r="1.5" fill="#0ca30c"/><rect x="9" y="13" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="15" r="1.5" fill="#0ca30c"/><rect x="9" y="20" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="22" r="1.5" fill="#fab219"/></svg>'),
    // 4: 传感器
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="22" r="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><path d="M8 16 Q16 8 24 16" fill="none" stroke="#3987e5" stroke-width="1.5" opacity=".6"/><path d="M4 12 Q16 2 28 12" fill="none" stroke="#3987e5" stroke-width="1.2" opacity=".4"/><line x1="16" y1="22" x2="16" y2="8" stroke="#3987e5" stroke-width="1.8"/><circle cx="16" cy="6" r="2" fill="#0ca30c"/></svg>'),
    // 5: 通用设备
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="6" width="20" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="10" y="10" width="12" height="12" rx="2" fill="none" stroke="#c3c2b7" stroke-width="1"/><circle cx="16" cy="16" r="3" fill="#0ca30c"/><line x1="6" y1="12" x2="2" y2="12" stroke="#3987e5" stroke-width="1.2"/><line x1="6" y1="16" x2="2" y2="16" stroke="#3987e5" stroke-width="1.2"/><line x1="6" y1="20" x2="2" y2="20" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="12" x2="30" y2="12" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="16" x2="30" y2="16" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="20" x2="30" y2="20" stroke="#3987e5" stroke-width="1.2"/></svg>'),
  ]
  const PRESET_ICON_LABELS = ['电池柜', 'PLC 控制器', '温控器', '服务器', '传感器', '通用设备']

  function getWords(area, type) {
    if (area === 'coil' || area === 'discrete') return 1
    return Codec.TYPES[type] ? Codec.TYPES[type].words : 1
  }

  function buildInstanceCfg(inst) {
    const type = state.types.find(t => t.id === inst.typeId)
    return DeviceConfig.buildDeviceConfig(inst, type, ReadPlan.buildReadPlan)
  }

  function formatConnectionTarget(inst) {
    return ConnectionUI.formatConnectionTarget(inst)
  }

  function loadFromConfig(cfg) {
    const loaded = DeviceConfig.normalizeLoadedDevices(cfg)
    state.types = loaded.types
    state.instances = loaded.instances
    loaded.warnings.forEach(message => log('error', `配置加载警告：${message}`))
    state.instances.forEach(inst => {
      const n = parseInt(inst.id.replace('dev', ''))
      if (n >= nextId) nextId = n + 1
    })
  }

  async function saveToConfig() {
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, deviceTypes: state.types, deviceInstances: state.instances })
  }

  async function persistInstances(nextInstances) {
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({ ...cfg, deviceInstances: nextInstances })
  }

  function log(level, message) {
    if (window._appLogFn) window._appLogFn(level, message)
    else console[level](message)
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;')
  }

  // ── 获取预设图标 data URI ──
  function getIconSrc(inst) {
    const idx = inst.iconIdx != null ? inst.iconIdx : 0
    return PRESET_ICONS[idx] || PRESET_ICONS[0]
  }

  // ── 渲染图标选择器（可聚焦 radio button + roving tabindex）──
  function renderIconSelector(selectedIdx) {
    const container = $('iconSelector')
    if (!container) return
    container.replaceChildren()
    const buttons = PRESET_ICONS.map((svg, i) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'icon-opt'
      button.dataset.idx = String(i)
      button.title = PRESET_ICON_LABELS[i]
      button.setAttribute('role', 'radio')
      button.innerHTML = `<img src="${svg}" width="32" height="32" alt="${PRESET_ICON_LABELS[i]}">
        <span>${PRESET_ICON_LABELS[i]}</span>`
      container.appendChild(button)
      return button
    })
    buttons.forEach((button, i) => {
      button.addEventListener('click', () => DeviceConfig.applyRadioSelection(buttons, i))
      button.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return
        event.preventDefault()
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        const next = (i + (forward ? 1 : buttons.length - 1)) % buttons.length
        DeviceConfig.applyRadioSelection(buttons, next)
        buttons[next].focus()
      })
    })
    DeviceConfig.applyRadioSelection(buttons, selectedIdx)
  }

  function getSelectedIconIdx() {
    const active = $('iconSelector')?.querySelector('.icon-opt.active')
    return active ? Number(active.dataset.idx) : 0
  }

  // ── 实例启停 ──
  const instanceToggleRunner = DeviceConfig.createKeyedExclusiveRunner()

  function toggleInstance(id) {
    return instanceToggleRunner.run(id, () => toggleInstanceNow(id))
  }

  async function toggleInstanceNow(id) {
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
      log('info', `设备「${inst.name}」已启动（${formatConnectionTarget(inst)}）`)
    } catch (err) {
      state.running[id] = false; state.statuses[id] = 'error'
      renderOverviewPage(); renderMgrPage()
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      log('error', `设备「${inst.name}」启动失败（${formatConnectionTarget(inst)}）：${msg}`)
    }
  }

  // ── 事件处理 ──
  function onDeviceData(d) {
    state.data[d.id] = d.blocks
    state.skipped[d.id] = d.skipped || []
    // 多客户端同步：后端在给这台设备推数据，说明它正在运行；本客户端若还不知道，
    // 补上 running 状态并重绘总览，让未亲自点启动的客户端也能显示数据
    if (!state.running[d.id]) {
      state.running[d.id] = true
      if (state.statuses[d.id] === undefined) state.statuses[d.id] = 'connected'
      renderOverviewPage()
      if (window.populateDeviceDebugSel) window.populateDeviceDebugSel()
    }
    renderInstanceCards(d.id)
    // 设备调试页正在看这台设备时，实时刷新其数值单元格
    if (window.refreshDdValues) window.refreshDdValues(d.id)
  }

  function onDeviceStatus(s) {
    state.statuses[s.id] = s.state
    if (s.state === 'disconnected') state.running[s.id] = false
    // 更新总览页状态
    const group = [...document.querySelectorAll('.dev-group[data-inst-id]')]
      .find(element => element.dataset.instId === String(s.id))
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
      const thumbHtml = `<img class="dev-thumb-img" src="${getIconSrc(inst)}">`
      const safeId = escapeAttr(inst.id)
      html += `<section class="dev-group ${offline ? 'offline' : ''}" data-inst-id="${safeId}">
        <div class="dev-head">
          <span class="collapse-toggle" data-inst-id="${safeId}">▾</span>
          ${thumbHtml}
          <span class="dev-name">${escapeHtml(inst.name)}</span>
          <span class="dev-meta">${escapeHtml(formatConnectionTarget(inst))} · 周期 ${inst.interval}ms</span>
          <span class="pill"><span class="dot ${statusDot}"></span>${statusText}</span>
          <button class="btn ghost sm dev-debug-ov" data-id="${safeId}">🔧 调试</button>
          <button class="btn ghost sm dev-toggle-ov" data-id="${safeId}">${running ? '⏸ 停止' : '▶ 启动'}</button>
        </div>
        <div class="dev-body" id="ovBody_${safeId}"></div>
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
    // 绑定跳转设备调试
    content.querySelectorAll('.dev-debug-ov').forEach(btn => {
      btn.addEventListener('click', () => { if (window.gotoDeviceDebug) window.gotoDeviceDebug(btn.dataset.id) })
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
      if (p.visible === false) return
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
        typeList.insertAdjacentHTML('beforeend', `<div class="list-count">共 ${state.types.length} 个类型</div>`)
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
          const safeId = escapeAttr(inst.id)
          return `<div class="mgr-row">
            <span class="dot ${dotCls}"></span>
            <span class="mgr-name">${escapeHtml(inst.name)}</span>
            <span class="mgr-meta">${type ? escapeHtml(type.name) : '（未知）'} · ${escapeHtml(formatConnectionTarget(inst))} · ${running ? '运行中' : '已停止'}</span>
            <button class="btn ghost sm mgr-toggle-inst" data-id="${safeId}">${running ? '停止' : '启动'}</button>
            <button class="btn ghost sm mgr-debug-inst" data-id="${safeId}">调试</button>
            <button class="btn ghost sm mgr-edit-inst" data-id="${safeId}">编辑</button>
            <button class="btn ghost sm mgr-del-inst" style="border-color:var(--status-critical);color:var(--status-critical)" data-id="${safeId}">删除</button>
          </div>`
        }).join('')
        // 直接绑定实例启停/编辑/删除
        instList.querySelectorAll('.mgr-toggle-inst').forEach(btn => btn.onclick = () => toggleInstance(btn.dataset.id))
        instList.querySelectorAll('.mgr-debug-inst').forEach(btn => btn.onclick = () => { if (window.gotoDeviceDebug) window.gotoDeviceDebug(btn.dataset.id) })
        instList.querySelectorAll('.mgr-edit-inst').forEach(btn => btn.onclick = () => editInstance(btn.dataset.id))
        instList.querySelectorAll('.mgr-del-inst').forEach(btn => btn.onclick = () => deleteInstance(btn.dataset.id))
        instList.insertAdjacentHTML('beforeend', `<div class="list-count">共 ${state.instances.length} 个实例</div>`)
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
    const previousTypes = state.types
    state.types = state.types.filter((_, typeIndex) => typeIndex !== idx)
    try {
      await saveToConfig(); renderMgrPage(); renderOverviewPage()
    } catch (error) {
      state.types = previousTypes
      alert('删除类型失败：' + (error.message || error))
    }
  }

  async function deleteInstance(id) {
    try {
      const inst = state.instances.find(i => i.id === id)
      if (!inst) { alert(`未找到实例 (${id})，请刷新页面重试`); return }
      if (!confirm(`确定删除实例「${inst.name}」？`)) return
      // 页面刷新后 running 状态可能为空，仍必须让后端幂等停止该实例。
      await DeviceConfig.deleteInstanceSafely(id, window.api.deviceStop, async () => {
        const nextInstances = state.instances.filter(i => i.id !== id)
        await DeviceConfig.commitInstanceList(nextInstances, persistInstances, next => { state.instances = next })
      }, () => {
        state.running[id] = false
        state.statuses[id] = 'disconnected'
      })
      delete state.running[id]; delete state.statuses[id]; delete state.data[id]; delete state.skipped[id]
      renderMgrPage(); renderOverviewPage()
    } catch (e) {
      console.error('deleteInstance 异常', e)
      if (e.deviceStoppedBeforeDelete) { renderMgrPage(); renderOverviewPage() }
      alert(e.deviceStoppedBeforeDelete
        ? `设备已停止但删除配置保存失败，可重试：${e.message || e}`
        : '删除失败: ' + (e.message || e))
    }
  }

  // 从编辑表格逐行收集点位；返回 { ok, points, error }
  // basePoints：类型现有点位（作为基底）。只用 DOM 中实际渲染的行（按 realIndex）覆盖对应点位，
  // 这样在启用名称筛选、只渲染部分行时保存，不会丢弃未渲染的点位。
  function collectPointsFromTable(basePoints = []) {
    const rows = $('typePointsTbody').querySelectorAll('tr')
    const result = basePoints.map(p => ({ ...p }))
    for (let ri = 0; ri < rows.length; ri++) {
      const tr = rows[ri]
      const nameInput = tr.querySelector('.tp-name'); const areaSel = tr.querySelector('.tp-area')
      const addrInput = tr.querySelector('.tp-addr'); const typeSel = tr.querySelector('.tp-type')
      const orderSel = tr.querySelector('.tp-order'); const kInput = tr.querySelector('.tp-k')
      const bInput = tr.querySelector('.tp-b'); const decInput = tr.querySelector('.tp-dec'); const unitInput = tr.querySelector('.tp-unit')
      const visibleCheck = tr.querySelector('.tp-visible')
      if (!nameInput) continue  // 空态占位行
      const pName = nameInput.value.trim()
      if (!pName) return { ok: false, error: `第 ${ri + 1} 行：点位名称不能为空` }
      // 地址解析：支持 16 进制输入
      const addrRaw = addrInput.value.trim()
      let addr
      if (/^0x[0-9a-fA-F]+$/.test(addrRaw)) {
        addr = parseInt(addrRaw, 16)
      } else {
        addr = Number(addrRaw)
      }
      if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return { ok: false, error: `第 ${ri + 1} 行：地址应为 0~65535 的整数` }
      const k = Number(kInput.value); const b = Number(bInput.value)
      if (Number.isNaN(k) || Number.isNaN(b)) return { ok: false, error: `第 ${ri + 1} 行：k 和 b 必须是数字` }
      const point = { name: pName, area: areaSel.value, addr, type: typeSel.value, wordOrder: orderSel.value, k, b, decimals: decInput.value.trim() === '' ? null : Number(decInput.value), unit: unitInput.value.trim(), visible: visibleCheck ? visibleCheck.checked : true }
      const realIndex = Number(tr.dataset.realIndex)
      if (Number.isInteger(realIndex) && realIndex >= 0 && realIndex < result.length) {
        result[realIndex] = point   // 覆盖已有点位
      } else {
        result.push(point)          // 新增行
      }
    }
    return { ok: true, points: result }
  }

  // 保存回调（编辑/新建共用）：校验 → 写回类型 → 落库
  async function saveTypeFromEditor(t) {
    const name = $('typeNameInput').value.trim()
    if (!name) { $('typeEditorError').textContent = '类型名称不能为空'; return }
    const c = collectPointsFromTable(t.points)
    if (!c.ok) { $('typeEditorError').textContent = c.error; return }
    const plan = ReadPlan.buildReadPlan(c.points.map(p => ({ area: p.area, addr: p.addr, words: getWords(p.area, p.type) })))
    if (plan.length > 8) { if (!confirm(`点位过于分散，将产生 ${plan.length} 个读取块，可能影响采集效率。是否继续？`)) return }
    t.name = name
    t.points = c.points
    try {
      await saveToConfig(); closeTypeEditor(); renderMgrPage(); renderOverviewPage()
      // 设备调试页若正在看该类型的设备，重绘以应用新的 k/b/单位/显示等
      if (window.rerenderDeviceDebug) window.rerenderDeviceDebug()
    } catch (error) {
      $('typeEditorError').textContent = '保存类型失败：' + (error.message || error)
    }
  }

  function openTypeEditor(idx) {
    const t = state.types[idx]
    if (!t) return
    $('typeEditorTitle').textContent = `编辑类型：${escapeHtml(t.name)}`
    $('typeNameInput').value = t.name
    renderTypePoints(t, idx)
    $('typeSaveBtn').onclick = () => saveTypeFromEditor(t)
    $('typeEditorModal').classList.remove('hidden')
  }

  function openTypeEditorForNew() {
    const t = { id: genId(), name: '新类型', points: [] }
    state.types.push(t)
    $('typeEditorTitle').textContent = '新建类型'
    $('typeNameInput').value = t.name
    renderTypePoints(t, state.types.length - 1)
    $('typeSaveBtn').onclick = () => saveTypeFromEditor(t)
    $('typeEditorModal').classList.remove('hidden')
    // 自动聚焦并全选类型名称，方便改默认名
    setTimeout(() => {
      const input = $('typeNameInput')
      if (input && document.activeElement !== input) {
        input.focus()
        input.select()
      }
    }, 50)
  }

  // ── 类型点位编辑表格（复用 v0.2 逻辑） ──
  function renderTypePoints(t, idx) {
    const tbody = $('typePointsTbody'); tbody.innerHTML = ''
    if (t.points.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--ink-3)">暂无点位，点击下方添加</td></tr>'
    } else {
      const hexMode = $('hexAddrCheck')?.checked || false
      const filterText = ($('pointFilterInput')?.value || '').trim().toLowerCase()
      let shown = 0
      t.points.forEach((p, pi) => {
        // 筛选：按名称过滤
        if (filterText && !p.name.toLowerCase().includes(filterText)) return
        shown++
        addPointRow(tbody, p, idx, pi, hexMode)
      })
      const countEl = $('pointCount')
      if (countEl) countEl.textContent = filterText ? `显示 ${shown} / 共 ${t.points.length} 个点位` : `共 ${t.points.length} 个点位`
    }
    if (t.points.length === 0) { const c = $('pointCount'); if (c) c.textContent = '共 0 个点位' }

    // ── 筛选输入：实时过滤 ──
    $('pointFilterInput').oninput = () => renderTypePoints(state.types[idx], idx)
    // ── 16 进制地址勾选 ──
    $('hexAddrCheck').onchange = () => renderTypePoints(state.types[idx], idx)

    $('addPointBtn').onclick = () => {
      state.types[idx].points.push({ name: '', area: 'holding', addr: 0, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: null, unit: '', visible: true })
      renderTypePoints(state.types[idx], idx)
    }

    // ── 点表导出：取编辑器当前内容（含未保存修改）写 JSON 文件 ──
    $('exportPointsBtn').onclick = async () => {
      const c = collectPointsFromTable(t.points)
      if (!c.ok) { $('typeEditorError').textContent = c.error; return }
      if (c.points.length === 0) { $('typeEditorError').textContent = '没有可导出的点位'; return }
      const typeName = $('typeNameInput').value.trim() || t.name
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const payload = { schema: 'modbusmate-points@1', typeName, exportedAt: new Date().toISOString(), points: c.points }
      const r = await window.api.exportPoints({ defaultName: `点表-${typeName}-${stamp}.json`, json: JSON.stringify(payload, null, 2) })
      if (r.ok) $('typeEditorError').textContent = ''
      else if (!r.canceled) $('typeEditorError').textContent = '导出失败：' + r.error
    }

    // ── 点表导入：校验通过后替换编辑器表格，点「保存」才落库 ──
    $('importPointsBtn').onclick = async () => {
      const r = await window.api.importPoints()
      if (!r.ok) { if (!r.canceled) $('typeEditorError').textContent = '读取文件失败：' + r.error; return }
      let raw
      try { raw = JSON.parse(r.content) } catch { $('typeEditorError').textContent = '导入失败：文件不是有效的 JSON'; return }
      const v = Codec.validatePoints(raw)
      if (!v.ok) { $('typeEditorError').textContent = '导入失败：' + v.error; return }
      if (state.types[idx].points.length > 0 && !confirm(`导入将替换当前 ${state.types[idx].points.length} 个点位，是否继续？`)) return
      state.types[idx].points = v.points
      renderTypePoints(state.types[idx], idx)
      $('typeEditorError').textContent = ''
    }
  }

  function addPointRow(tbody, p, typeIdx, pointIdx, hexMode = false) {
    const tr = document.createElement('tr')
    tr.dataset.realIndex = pointIdx  // 记录在类型 points 数组中的真实索引
    const areaOptions = [
      { v: 'holding',  l: '保持寄存器 (03/06·16)' },
      { v: 'input',   l: '输入寄存器 (04·只读)' },
      { v: 'coil',    l: '线圈 (01/05)' },
      { v: 'discrete',l: '离散输入 (02·只读)' },
    ].map(a => `<option value="${a.v}" ${p.area === a.v ? 'selected' : ''}>${a.l}</option>`).join('')
    const typeOptions = Object.entries(Codec.TYPES).map(([k, v]) =>
      `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.label}</option>`).join('')
    const addrDisplay = hexMode ? '0x' + p.addr.toString(16).toUpperCase() : p.addr
    const isReadonly = p.area === 'input' || p.area === 'discrete'
    // 只读区域的类型只显示 uint16（位区域同理）
    const typeCellHtml = isReadonly ? `<select class="tp-type"><option value="uint16" selected>UInt16</option></select>` : `<select class="tp-type">${typeOptions}</select>`
    const visibleChecked = p.visible !== false ? ' checked' : ''
    tr.innerHTML = `<td><input class="tp-name" value="${escapeHtml(p.name)}" placeholder="名称"></td>
      <td><select class="tp-area">${areaOptions}</select></td>
      <td><input class="tp-addr" type="text" value="${escapeHtml(String(addrDisplay))}" data-hex="${hexMode ? '1' : '0'}" data-dec="${p.addr}" placeholder="地址"></td>
      <td>${typeCellHtml}</td>
      <td><select class="tp-order"><option ${p.wordOrder === 'AB' ? 'selected' : ''}>AB</option><option ${p.wordOrder === 'BA' ? 'selected' : ''}>BA</option></select></td>
      <td><input class="tp-k" type="number" step="any" value="${p.k}"></td>
      <td><input class="tp-b" type="number" step="any" value="${p.b}"></td>
      <td><input class="tp-dec" type="number" min="0" max="6" value="${p.decimals ?? ''}" placeholder="自动"></td>
      <td><input class="tp-unit" value="${escapeHtml(p.unit)}" placeholder="单位"></td>
      <td style="text-align:center"><input type="checkbox" class="tp-visible"${visibleChecked} title="是否在总览/调试页显示"></td>
      <td style="white-space:nowrap">
        <button class="tp-move-btn tp-up" ${pointIdx === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button class="tp-move-btn tp-down" ${pointIdx >= state.types[typeIdx].points.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button class="tp-del-btn" style="margin-left:2px">×</button>
      </td>`
    // 删除按钮
    tr.querySelector('.tp-del-btn').addEventListener('click', () => {
      state.types[typeIdx].points.splice(pointIdx, 1)
      renderTypePoints(state.types[typeIdx], typeIdx)
    })
    // 上移
    tr.querySelector('.tp-up').addEventListener('click', () => {
      if (pointIdx <= 0) return
      const pts = state.types[typeIdx].points
      ;[pts[pointIdx - 1], pts[pointIdx]] = [pts[pointIdx], pts[pointIdx - 1]]
      renderTypePoints(state.types[typeIdx], typeIdx)
    })
    // 下移
    tr.querySelector('.tp-down').addEventListener('click', () => {
      const pts = state.types[typeIdx].points
      if (pointIdx >= pts.length - 1) return
      ;[pts[pointIdx], pts[pointIdx + 1]] = [pts[pointIdx + 1], pts[pointIdx]]
      renderTypePoints(state.types[typeIdx], typeIdx)
    })
    // 区域变化时联动：只读区域（input/discrete）限制类型
    tr.querySelector('.tp-area').addEventListener('change', (e) => {
      const area = e.target.value
      const typeSel = tr.querySelector('.tp-type')
      if (area === 'input' || area === 'discrete') {
        typeSel.innerHTML = '<option value="uint16" selected>UInt16</option>'
      } else if (typeSel.options.length <= 1) {
        typeSel.innerHTML = typeOptions
      }
    })
    tbody.appendChild(tr)
  }

  function closeTypeEditor() {
    $('typeEditorModal').classList.add('hidden')
    $('typeEditorError').textContent = ''
  }

  // ── 实例管理弹窗 ──
  const instanceSerialLoader = ConnectionUI.createSerialPortLoader(() => window.api.listSerialPorts())
  const instanceModalGuard = DeviceConfig.createSessionGuard()
  let instanceModalSession = null
  let instancePreviousFocus = null
  let instanceKeydownHandler = null
  const instanceSaveAction = DeviceConfig.createExclusiveAction(pending => {
    $('instModalOk').disabled = pending
    $('instModalCancel').disabled = pending
  })
  const instanceDialogKeyController = DeviceConfig.createDialogKeyController({
    getControls: () => DeviceConfig.getFocusable($('instanceModal')),
    getActive: () => document.activeElement,
    onEscape: () => closeInstanceModal(),
  })

  function handleInstanceModalKeydown(event) {
    if (event.key === 'Escape' && instanceSaveAction.isPending()) return
    instanceDialogKeyController.handle(event)
  }

  function updateInstanceConnectionFields(transport, autoRefresh = false) {
    const normalized = ConnectionUI.normalizeTransport(transport)
    const isRtu = normalized === 'rtu'
    $('instTransport').value = normalized
    $('instTcpFields').classList.toggle('hidden', isRtu)
    $('instTcpFields').setAttribute('aria-hidden', String(isRtu))
    $('instTcpFields').querySelectorAll('input, select, button').forEach(control => { control.disabled = isRtu })
    $('instRtuFields').classList.toggle('hidden', !isRtu)
    $('instRtuFields').setAttribute('aria-hidden', String(!isRtu))
    $('instRtuFields').querySelectorAll('input, select, button').forEach(control => { control.disabled = !isRtu })
    $('instUnitId').min = isRtu ? '1' : '0'
    $('instUnitId').max = isRtu ? '247' : '255'
    if (isRtu && autoRefresh) refreshInstanceSerialPorts(instanceModalSession)
  }

  function renderInstanceSerialPorts(ports) {
    const select = $('instSerialPath')
    const current = select.value
    const options = ConnectionUI.mergeSerialPortOptions(current, ports)
    select.replaceChildren()
    if (!options.length) {
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = '未发现串口，请连接 USB/RS485 设备后刷新'
      select.appendChild(placeholder)
      return
    }
    options.forEach(port => {
      const option = document.createElement('option')
      option.value = port.path
      option.textContent = ConnectionUI.serialPortLabel(port)
      select.appendChild(option)
    })
    if (options.some(port => port.path === current)) select.value = current
  }

  async function refreshInstanceSerialPorts(session = instanceModalSession) {
    const button = $('instRefreshSerialBtn')
    button.disabled = true
    button.textContent = '刷新中…'
    try {
      const ports = await instanceSerialLoader.load()
      if (!instanceModalGuard.isCurrent(session) || $('instanceModal').classList.contains('hidden') || $('instTransport').value !== 'rtu') return ports
      renderInstanceSerialPorts(ports)
      $('instModalError').textContent = ''
      return ports
    } catch (error) {
      if (instanceModalGuard.isCurrent(session) && !$('instanceModal').classList.contains('hidden')) {
        const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        $('instModalError').textContent = `刷新串口失败：${message}；请检查 USB/RS485 转换器、驱动和系统串口权限`
      }
      return null
    } finally {
      if (instanceModalGuard.isCurrent(session)) {
        button.textContent = '刷新'
        button.disabled = $('instTransport').value !== 'rtu'
      }
    }
  }

  function readInstanceFormValues() {
    return {
      typeId: $('instTypeSel').value,
      name: $('instName').value,
      iconIdx: getSelectedIconIdx(),
      interval: $('instInterval').value,
      transport: $('instTransport').value,
      host: $('instHost').value,
      port: $('instPort').value,
      serialPath: $('instSerialPath').value,
      baudRate: $('instBaudRate').value,
      dataBits: $('instDataBits').value,
      parity: $('instParity').value,
      stopBits: $('instStopBits').value,
      unitId: $('instUnitId').value,
      timeout: $('instTimeout').value,
    }
  }

  function configureInstanceModal(existing) {
    instancePreviousFocus = document.activeElement
    instanceModalSession = instanceModalGuard.begin()
    $('instanceModal').classList.remove('hidden')
    const typeSelect = $('instTypeSel')
    typeSelect.replaceChildren()
    state.types.forEach(type => {
      const option = document.createElement('option')
      option.value = type.id
      option.textContent = type.name
      typeSelect.appendChild(option)
    })
    if (existing?.typeId) typeSelect.value = existing.typeId
    const view = DeviceConfig.normalizeInstanceView(existing || {
      transport: 'tcp', host: '192.168.1.', port: 502, unitId: 1, timeout: 2000,
    })
    $('instName').value = existing?.name || ''
    $('instTransport').value = view.transport
    $('instHost').value = view.host || '192.168.1.'
    $('instPort').value = view.port
    $('instBaudRate').value = String(view.baudRate || 9600)
    $('instDataBits').value = view.dataBits
    $('instParity').value = view.parity
    $('instStopBits').value = view.stopBits
    $('instUnitId').value = view.unitId
    $('instTimeout').value = view.timeout
    $('instInterval').value = existing?.interval || 1000
    $('instModalError').textContent = ''
    $('instModalTitle').textContent = existing ? '编辑设备实例' : '添加设备实例'
    $('instModalOk').disabled = false
    $('instModalCancel').disabled = false
    renderIconSelector(existing?.iconIdx != null ? existing.iconIdx : 0)

    const serialSelect = $('instSerialPath')
    serialSelect.replaceChildren()
    const serialOption = document.createElement('option')
    serialOption.value = view.serialPath
    serialOption.textContent = view.serialPath ? `${view.serialPath}（当前不可用）` : '请选择串口'
    serialSelect.appendChild(serialOption)
    serialSelect.value = view.serialPath
    updateInstanceConnectionFields(view.transport)

    $('instTransport').onchange = () => {
      instanceModalGuard.invalidate()
      instanceModalSession = instanceModalGuard.begin()
      updateInstanceConnectionFields($('instTransport').value, true)
    }
    $('instRefreshSerialBtn').onclick = () => refreshInstanceSerialPorts(instanceModalSession)
    if (view.transport === 'rtu') refreshInstanceSerialPorts(instanceModalSession)

    $('instModalOk').onclick = () => instanceSaveAction.run(async () => {
      try {
        if (existing) DeviceConfig.assertInstanceEditable(state.running[existing.id])
        const record = DeviceConfig.buildInstanceRecord(existing || { id: genId() }, readInstanceFormValues())
        let nextInstances
        if (existing) {
          const index = state.instances.findIndex(inst => inst.id === existing.id)
          if (index < 0) throw new Error('未找到实例，请刷新页面后重试')
          nextInstances = state.instances.map((inst, instanceIndex) => instanceIndex === index ? record : inst)
        } else {
          nextInstances = [...state.instances, record]
        }
        await DeviceConfig.commitInstanceList(nextInstances, persistInstances, next => { state.instances = next })
        closeInstanceModal(true); renderMgrPage(); renderOverviewPage()
        log('info', `${existing ? '已更新' : '已添加'}设备实例「${record.name}」（${formatConnectionTarget(record)}）`)
        if (!existing) window.switchNav('mgr')
        if (window.populateDeviceDebugSel) window.populateDeviceDebugSel()
      } catch (error) {
        $('instModalError').textContent = error.message || String(error)
      }
    })

    if (instanceKeydownHandler) document.removeEventListener('keydown', instanceKeydownHandler)
    instanceKeydownHandler = handleInstanceModalKeydown
    document.addEventListener('keydown', instanceKeydownHandler)
    $('instName').focus()
  }

  function openInstanceModal() {
    if (state.types.length === 0) { log('error', '请先创建设备类型'); return }
    configureInstanceModal(null)
  }

  function closeInstanceModal(force = false) {
    if (instanceSaveAction.isPending() && !force) return
    instanceModalGuard.invalidate()
    instanceModalSession = null
    if (instanceKeydownHandler) {
      document.removeEventListener('keydown', instanceKeydownHandler)
      instanceKeydownHandler = null
    }
    $('instRefreshSerialBtn').textContent = '刷新'
    $('instanceModal').classList.add('hidden')
    $('instModalError').textContent = ''
    const focusTarget = instancePreviousFocus
    instancePreviousFocus = null
    if (focusTarget?.isConnected && typeof focusTarget.focus === 'function') focusTarget.focus()
  }

  // ── 编辑实例（复用弹窗） ──
  function editInstance(id) {
    const inst = state.instances.find(i => i.id === id)
    if (!inst) { alert('未找到实例'); return }
    if (state.running[id]) { alert('请先停止设备再编辑'); return }
    configureInstanceModal(inst)
  }

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
    closeInstanceModal,
    openTypeEditor,
    openTypeEditorForNew,
  }
})()
window.DeviceUI = DeviceUI
