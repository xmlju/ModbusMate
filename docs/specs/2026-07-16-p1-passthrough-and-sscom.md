# P1 规格:透传原则整改 + SSCOM 式原始报文

> 产品定位铁律(2026-07-16 确立):**ModbusMate 是调试工具,不是业务系统。凡设备能拒绝的,让设备拒绝;软件只拦"物理上发不出去的帧"。** 所有解释性文案(异常码翻译等)只做备注,永远同时展示原始码/原始字节,绝不拦截。

## A. 透传审计整改

| # | 现状 | 整改 | 文件 |
|---|---|---|---|
| A1 | 轮询周期只能选固定档(100/500/1000/2000/5000/10000/15000) | 改为自由数值输入(ms),仅校验为 ≥50 的整数;UI 下拉改输入框+常用值 datalist | `renderer/device-config.js` `VALID_INTERVALS`、`renderer/index.html` 实例弹窗 |
| A2 | 类型编辑器里 input/discrete 区域类型下拉强制只有 UInt16 | 放开为全部类型(input 区本来就存在 uint32/float 测量值,今天实测的表就有) | `renderer/device.js` `addPointRow` 的 `typeCellHtml` |
| A3 | 保存类型时"读取块>8"弹 confirm 拦截 | 改为非拦截提示(editor error 区显示黄色警告文案,照常保存) | `renderer/device.js` `saveTypeFromEditor` |
| A4 | 原始报文构造模式功能码白名单 `SUPPORTED_RAW_FUNCTIONS` | 白名单仅约束"构造"页签的下拉选项(它天生只能列有限项),**自由报文页签无任何功能码限制**(见 B) | `main/transports/modbus-transport.js` |
| A5 | 协议帧限制(读≤125/写≤123/地址≤65535/CRC) | **保留**——这是"发不出去的帧",不是业务判断 | 不动 |

## B. SSCOM 式自由报文发送

在调试工作台"原始报文发送"面板改为两个页签:**构造模式**(Codex 已实现,保留)+ **自由报文**(新增)。

### 交互(对标 SSCOM)
- 16 进制输入框:接受 `01 03 00 00 00 0A` / `010300००000A` 等,空格容忍,非 hex 字符即时红字提示
- ☑ **自动追加 CRC16**(默认勾选);不勾则原样发送用户字节
- 目标选择:下拉选一个**已配置的设备实例**(复用其连接,与轮询共存插队发送);实例未启动时提示先启动
- 响应超时(ms)输入框,默认 1000
- 发送历史:最近 20 条,localStorage 持久,点击回填
- 定时循环发送:间隔(ms)+ 启/停按钮
- 收发日志:时间戳 + `TX →` / `RX ←` + hex 字节;RX 若可识别为 Modbus 异常帧,行尾灰字备注解释(**只备注不拦截**)

### 后端
- 新通道 `device:rawFrame`,参数 `{ id, frameHex, appendCrc, timeoutMs }`,返回 `{ tx, rx }`(hex 字符串)
- 路径:`DeviceManager.rawFrame(id, ...)` → 实例 service → transport 新方法 `rawFrame(bytes, timeoutMs)`
- **transport 实现要点**:
  - 走 `_enqueueOperation`,与轮询读写严格串行,不会撕帧
  - 直接写底层串口(`client._port` 一层),旁路 modbus-serial 的请求构造器
  - 收帧:首字节后按**帧间静默 20ms** 判帧结束,总超时 timeoutMs;超时无字节返回空 rx(不算错误,SSCOM 语义)
  - 注意屏蔽 modbus-serial 自身 parser 对这段字节流的干扰(发送期间摘掉/恢复其 data 监听,或确认其空闲队列会丢弃即可,需实测)
  - v1 仅支持 RTU 实例;TCP 实例调用返回明确错误"自由报文暂只支持 RTU"
- CRC16(Modbus)工具函数放 `renderer/`+`main/` 共用或各一份,带单测(标准测试向量:`01 03 00 00 00 0A` → CRC `C5 CD`,请以标准算法实际计算值为准写测试)

### 验收
- `npx vitest run` 全绿;rawFrame 收帧逻辑、CRC16、hex 解析均有单测
- 网页版实测:实例轮询中发送一条读报文,TX/RX 正确、轮询不断线
- 发送设备不认的帧(如错误 CRC、不存在的功能码 0x55):软件不拦,如实显示设备回应或超时
