# 实施计划：点位编辑弹窗显示修复 + 点表导入导出

> 日期：2026-07-15　执行：Trae　审查：Claude
> 涉及文件：`renderer/style.css`、`renderer/index.html`、`renderer/device.js`、`renderer/codec.js`、`main/index.js`、`preload.js`、`test/`

---

## 任务 A：点位编辑弹窗文字显示不全（Bug 修复）

### 根因

`#typeEditorModal` 弹窗宽 820px，内部点位表格 10 列：
- `table { width: 100% }` 使 10 列强行平分宽度；
- 输入框 `min-width: 50px`、单位/k/b 列还有内联 `style="width:60px/50px"`，
  导致「名称」「区域」等中文内容列被压缩到只显示 2~3 个字。

### 修改 1：`renderer/style.css` — 表格按内容撑开 + 各列最小宽度

将现有 `.type-points-table-wrap` 区块替换为：

```css
/* ── 类型点位编辑表格 ── */
.type-points-table-wrap { max-height: 56vh; overflow: auto; margin: 10px 0; }
.type-points-table-wrap table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
.type-points-table-wrap th, .type-points-table-wrap td { padding: 4px 6px; border: 1px solid var(--border); text-align: left; white-space: nowrap; }
.type-points-table-wrap th { background: var(--surface-2); position: sticky; top: 0; color: var(--ink-2); z-index: 1; }
.type-points-table-wrap input, .type-points-table-wrap select { padding: 2px 4px; border: 1px solid var(--border); border-radius: 3px; width: 100%; background: var(--surface-2); color: var(--ink-1); }
/* 各列最小宽度：名称/区域给足中文空间，数字列紧凑 */
.type-points-table-wrap th:nth-child(1), .type-points-table-wrap td:nth-child(1) { min-width: 150px; }  /* 名称 */
.type-points-table-wrap th:nth-child(2), .type-points-table-wrap td:nth-child(2) { min-width: 110px; }  /* 区域 */
.type-points-table-wrap th:nth-child(3), .type-points-table-wrap td:nth-child(3) { min-width: 80px; }   /* 地址 */
.type-points-table-wrap th:nth-child(4), .type-points-table-wrap td:nth-child(4) { min-width: 90px; }   /* 类型 */
.type-points-table-wrap th:nth-child(5), .type-points-table-wrap td:nth-child(5) { min-width: 64px; }   /* 字序 */
.type-points-table-wrap th:nth-child(6), .type-points-table-wrap td:nth-child(6) { min-width: 70px; }   /* k */
.type-points-table-wrap th:nth-child(7), .type-points-table-wrap td:nth-child(7) { min-width: 70px; }   /* b */
.type-points-table-wrap th:nth-child(8), .type-points-table-wrap td:nth-child(8) { min-width: 70px; }   /* 小数位 */
.type-points-table-wrap th:nth-child(9), .type-points-table-wrap td:nth-child(9) { min-width: 64px; }   /* 单位 */
.type-points-table-wrap th:nth-child(10), .type-points-table-wrap td:nth-child(10) { min-width: 36px; } /* 删除 */
```

要点：`width: max-content; min-width: 100%` 让列按内容自然撑开、窄时仍占满，
超宽时由 wrap 横向滚动兜底；原来的 `input { min-width: 50px }` 删除（由列宽约束）。

### 修改 2：`renderer/device.js` `addPointRow()` — 删除内联宽度

`tp-k`、`tp-b`、`tp-dec`、`tp-unit` 四个 input 上的 `style="width:60px"` / `style="width:50px"`
全部删除，宽度交给 CSS 的 `width:100%` + 列 `min-width` 控制。

### 修改 3：`renderer/index.html` — 弹窗加宽

`#typeEditorModal` 的 `.modal-box`：`style="width:820px;max-width:95vw"` → `style="width:960px;max-width:95vw"`。

### 验收标准

- 打开「云快充充电枪」类型编辑（15 个点位），名称列完整显示「电池组最高温度」7 个字；
- 区域下拉完整显示「保持寄存器」；
- 窗口缩小时表格出现横向滚动条，不再挤压列。

---

## 任务 B：点表导入导出（JSON）

### 交互设计

类型编辑弹窗（`#typeEditorModal`）标题下方新增一行工具按钮：

```html
<div style="display:flex;gap:8px;margin:6px 0;justify-content:flex-start">
  <button id="importPointsBtn" class="btn ghost sm">⬆ 导入点表</button>
  <button id="exportPointsBtn" class="btn ghost sm">⬇ 导出点表</button>
</div>
```

- **导出**：把编辑器里当前点位（含未保存修改）写成 JSON 文件，弹系统保存对话框，
  默认文件名 `点表-<类型名>-YYYYMMDD.json`；
- **导入**：弹系统打开对话框选 JSON → 校验 → 若当前表格已有点位，`confirm('导入将替换当前点位列表，是否继续？')` → 替换编辑器表格内容。**导入只改编辑器，用户点「保存」才落库**（与手工编辑一致，可取消）。

### 文件格式（schema v1）

```json
{
  "schema": "modbusmate-points@1",
  "typeName": "云快充充电枪",
  "exportedAt": "2026-07-15T12:00:00.000Z",
  "points": [
    { "name": "输出电压", "area": "holding", "addr": 4, "type": "uint16", "wordOrder": "AB", "k": 0.1, "b": 0, "decimals": 1, "unit": "V" }
  ]
}
```

导入时兼容两种输入：完整对象（取 `points` 字段）或裸点位数组。

### 修改 1：`main/index.js` — 新增两个 IPC（文件对话框须在主进程）

```js
const { dialog } = require('electron')  // 并入现有 require

// 点表导出：系统保存对话框 + 写文件
ipcMain.handle('points:export', async (_e, { defaultName, json }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'JSON 点表', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try { fs.writeFileSync(filePath, json, 'utf8'); return { ok: true, path: filePath } }
  catch (e) { return { ok: false, error: e.message } }
})

// 点表导入：系统打开对话框 + 读文件（内容原样返回，校验在渲染层做）
ipcMain.handle('points:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'JSON 点表', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths?.[0]) return { ok: false, canceled: true }
  try { return { ok: true, path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf8') } }
  catch (e) { return { ok: false, error: e.message } }
})
```

### 修改 2：`preload.js` — 暴露 API

```js
  // 点表导入导出
  exportPoints: p => ipcRenderer.invoke('points:export', p),
  importPoints: () => ipcRenderer.invoke('points:import'),
```

### 修改 3：`renderer/codec.js` — 纯函数校验（可单测）

在 Codec 内新增并导出 `validatePoints`：

```js
  const AREAS = ['holding', 'input', 'coil', 'discrete']

  // 校验导入的点表数据；返回 { ok, error, points }（points 为规范化后的副本）
  function validatePoints(raw) {
    const arr = Array.isArray(raw) ? raw : raw?.points
    if (!Array.isArray(arr)) return { ok: false, error: '文件格式错误：未找到点位数组' }
    if (arr.length === 0) return { ok: false, error: '点位列表为空' }
    const points = []
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i]; const row = `第 ${i + 1} 个点位`
      if (!p || typeof p !== 'object') return { ok: false, error: `${row}：格式错误` }
      const name = String(p.name ?? '').trim()
      if (!name) return { ok: false, error: `${row}：缺少名称` }
      if (!AREAS.includes(p.area)) return { ok: false, error: `${row}「${name}」：区域无效（${p.area}）` }
      if (!(p.type in TYPES)) return { ok: false, error: `${row}「${name}」：数据类型无效（${p.type}）` }
      const addr = Number(p.addr)
      if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return { ok: false, error: `${row}「${name}」：地址应为 0~65535 的整数` }
      const k = p.k === undefined ? 1 : Number(p.k)
      const b = p.b === undefined ? 0 : Number(p.b)
      if (Number.isNaN(k) || Number.isNaN(b)) return { ok: false, error: `${row}「${name}」：k/b 必须是数字` }
      let decimals = null
      if (p.decimals !== null && p.decimals !== undefined && p.decimals !== '') {
        decimals = Number(p.decimals)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return { ok: false, error: `${row}「${name}」：小数位应为 0~6 的整数` }
      }
      points.push({ name, area: p.area, addr, type: p.type, wordOrder: p.wordOrder === 'BA' ? 'BA' : 'AB', k, b, decimals, unit: String(p.unit ?? '').trim() })
    }
    return { ok: true, points }
  }
```

并加入 return 导出：`return { TYPES, decode, encode, toPlcAddress, toProtocolAddress, applyTransform, validatePoints }`。

### 修改 4：`renderer/device.js` — 抽取收集逻辑 + 接线按钮

1. **抽取 `collectPointsFromTable()`**：`openTypeEditor` 和 `openTypeEditorForNew` 的
   保存回调中逐行收集点位的代码完全重复，抽成一个函数返回
   `{ ok, points, error }`，两处保存回调与导出共用（消除现有重复）。

2. **在 `renderTypePoints(t, idx)` 里接线两个按钮**（与 `addPointBtn` 同处接线，闭包持有 t/idx）：

```js
    $('exportPointsBtn').onclick = async () => {
      const c = collectPointsFromTable()
      if (!c.ok) { $('typeEditorError').textContent = c.error; return }
      if (c.points.length === 0) { $('typeEditorError').textContent = '没有可导出的点位'; return }
      const typeName = $('typeNameInput').value.trim() || t.name
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const payload = { schema: 'modbusmate-points@1', typeName, exportedAt: new Date().toISOString(), points: c.points }
      const r = await window.api.exportPoints({ defaultName: `点表-${typeName}-${stamp}.json`, json: JSON.stringify(payload, null, 2) })
      if (r.ok) $('typeEditorError').textContent = ''
      else if (!r.canceled) $('typeEditorError').textContent = '导出失败：' + r.error
    }

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
```

### 修改 5：测试 — `test/codec-validate-points.test.js`（新增）

用 vitest 覆盖 `Codec.validatePoints`，至少：

- 合法完整对象（schema 包装）→ ok，点位数正确；
- 裸数组 → ok；
- 非数组/缺 points → 报「未找到点位数组」；
- 缺名称 / 区域非法 / 类型非法 / 地址越界(-1、65536、小数) / k 非数字 / 小数位 7 → 各自报对应行号错误；
- k/b/decimals/unit 缺省时的默认值（1 / 0 / null / ''）；
- wordOrder 非 'BA' 时一律规范为 'AB'。

### 验收标准

- 编辑「云快充充电枪」→ 导出 → 得到含 15 个点位的 JSON 文件；
- 新建类型 → 导入该文件 → 表格完整还原 15 个点位，点「保存」后落库；
- 导入损坏 JSON / 非法字段文件，错误提示落在弹窗错误栏且指明第几个点位；
- `npm test` 全绿。

---

## 任务 C：轮询周期支持 15 s（小改动，顺带）

云快充协议规定充电中 15 秒上送一次，但实例弹窗周期白名单没有 15000。

1. `renderer/index.html`：`#instInterval` 下拉新增 `<option value="15000">15 s</option>`；
2. `renderer/device.js`：周期校验白名单 `[100, 500, 1000, 2000, 5000, 10000]` 增加 `15000`（共两处：添加实例与编辑实例，如编辑处独立存在）。

---

## 完成后

跑 `npm test` 确认全绿，`npm start` 手工过一遍任务 A/B 验收标准。
不要提交 git——由姚鸣华审查后统一提交并打 tag 触发 GitHub Actions 打包。
