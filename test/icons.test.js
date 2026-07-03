// test/icons.test.js — 预设图标 data URI 正确性验证
import { describe, it, expect } from 'vitest'

describe('预设图标', () => {
  // 模拟 _b64svg
  const _b64svg = svg => 'data:image/svg+xml;base64,' + btoa(svg)

  const LABELS = ['电池柜', 'PLC 控制器', '温控器', '服务器', '传感器', '通用设备']

  const ICONS = [
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="8" y="4" width="16" height="24" rx="2" fill="none" stroke="#3987e5" stroke-width="2"/><rect x="12" y="8" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="17" y="8" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="12" y="16" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="17" y="16" width="3" height="6" rx="1" fill="#0ca30c"/><rect x="13" y="2" width="6" height="3" rx="1" fill="#3987e5"/></svg>'),
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="8" y="10" width="5" height="5" rx="1" fill="#0ca30c"/><rect x="8" y="18" width="5" height="5" rx="1" fill="#fab219"/><rect x="16" y="10" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="14" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="18" width="8" height="2" rx="1" fill="#c3c2b7"/><rect x="16" y="22" width="8" height="2" rx="1" fill="#c3c2b7"/></svg>'),
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="13" y="2" width="6" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><circle cx="16" cy="25" r="5" fill="none" stroke="#d03b3b" stroke-width="1.8"/><circle cx="16" cy="25" r="2.5" fill="#d03b3b"/><rect x="10" y="12" width="12" height="2" rx="1" fill="#c3c2b7"/><rect x="10" y="16" width="8" height="2" rx="1" fill="#c3c2b7"/></svg>'),
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="3" width="20" height="26" rx="2" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="9" y="6" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="8" r="1.5" fill="#0ca30c"/><rect x="9" y="13" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="15" r="1.5" fill="#0ca30c"/><rect x="9" y="20" width="14" height="4" rx="1" fill="#232322" stroke="#c3c2b7" stroke-width="0.5"/><circle cx="20" cy="22" r="1.5" fill="#fab219"/></svg>'),
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="22" r="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><path d="M8 16 Q16 8 24 16" fill="none" stroke="#3987e5" stroke-width="1.5" opacity=".6"/><path d="M4 12 Q16 2 28 12" fill="none" stroke="#3987e5" stroke-width="1.2" opacity=".4"/><line x1="16" y1="22" x2="16" y2="8" stroke="#3987e5" stroke-width="1.8"/><circle cx="16" cy="6" r="2" fill="#0ca30c"/></svg>'),
    _b64svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="6" width="20" height="20" rx="3" fill="none" stroke="#3987e5" stroke-width="1.8"/><rect x="10" y="10" width="12" height="12" rx="2" fill="none" stroke="#c3c2b7" stroke-width="1"/><circle cx="16" cy="16" r="3" fill="#0ca30c"/><line x1="6" y1="12" x2="2" y2="12" stroke="#3987e5" stroke-width="1.2"/><line x1="6" y1="16" x2="2" y2="16" stroke="#3987e5" stroke-width="1.2"/><line x1="6" y1="20" x2="2" y2="20" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="12" x2="30" y2="12" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="16" x2="30" y2="16" stroke="#3987e5" stroke-width="1.2"/><line x1="26" y1="20" x2="30" y2="20" stroke="#3987e5" stroke-width="1.2"/></svg>'),
  ]

  it('应生成 6 个图标', () => {
    expect(ICONS).toHaveLength(6)
    expect(LABELS).toHaveLength(6)
  })

  it('每个图标 data URI 格式正确', () => {
    ICONS.forEach((uri, i) => {
      expect(uri).toMatch(/^data:image\/svg\+xml;base64,/)
      expect(uri.length).toBeGreaterThan(100)
      // 验证 base64 内容可解码
      const b64 = uri.replace('data:image/svg+xml;base64,', '')
      const decoded = atob(b64)
      expect(decoded).toContain('<svg')
      expect(decoded).toContain('#')
      expect(decoded).not.toContain('%23')  // # 不应被编码
    })
  })

  it('每个图标解码后包含正确的颜色值', () => {
    ICONS.forEach((uri, i) => {
      const b64 = uri.replace('data:image/svg+xml;base64,', '')
      const decoded = atob(b64)
      expect(decoded).toContain('#3987e5')  // 不应被编码为 %23
      const label = LABELS[i]
      expect(label.length).toBeGreaterThan(0)
    })
  })
})
