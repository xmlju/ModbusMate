# Codex 任务书 — 2026-07-16 现场调试遗留问题

## 背景(必读)

今天现场调试"多功能双向直流电源"(吉事励,RTU 从站101/115200/8-N-2)发现的核心事实:

1. **该设备寄存器随工作模式(holding:0)整套增减**——切模式后另一批地址直接回异常码2。为此 `main/device-manager.js` 的 `_runTick` 已加入**坏块跳过容错**(未提交):坏块只跳过自己、好块照常出数;已知坏块每轮只探测 1 次不重试;全部块失败才算断连走离线重连。`device:data` 事件 payload 新增可选字段 `skipped: [{area, addr, count, message}]`。
2. **设备手册中的寄存器地址全部为 16 进制**(0x4544=17732),用户直接当 10 进制填过导致排查半天。
3. 写入弹窗(`renderer/app.js` 的 `confirmDDWrite`)目前要求填**原始寄存器值**,与表格显示的工程值(×k+b)不一致,用户会写错 10 倍。
4. 设备类型/实例配置存服务端 `config.json`(web 版数据目录 `~/Library/Application Support/modbusmate/`)。
5. 0x0C 等 ≥12 的异常码是厂商自定义,同一码不同设备含义不同(该设备="发生错误/开机禁止";海索PCS="需先关逆变")。目前 `main/transports/modbus-transport.js` 的 `EXCEPTION_HINTS[12]` 写死了海索 PCS 的文案,对其他设备是误导。

**约定**:注释用中文;错误提示要详细;代码结构简洁;跑 `npx vitest run` 全绿才算完成(当前基线 546 个测试全过)。

---

## 任务列表(按优先级)

### T1. 写入弹窗按 k/b 自动换算(高)

`renderer/app.js`:`openDDWriteModal` / `confirmDDWrite`。

- 写入按钮 dataset 需带上该点位的 `k`、`b`、`decimals`、`unit`(见 418 行按钮模板与 431 行绑定处)。
- 弹窗提示改为输入**工程值**:如 k=0.1 时提示"输入工程值(单位 A),自动换算为寄存器原始值"。
- `confirmDDWrite` 中非 coil、非 hex 类型:`原始值 = Math.round((输入 - b) / k)`,注意浮点误差(4/0.1=40.000…01)。k=1 且 b=0 时行为与现状一致。
- 写入成功日志同时显示工程值和原始值,例如 `4A (原始值 40)`。
- coil 与 hex 类型保持现状。

### T2. 设备调试页地址列加进制标识(高)

`renderer/app.js` 设备调试表格(搜 `dd-write` 附近的行渲染)。

- 地址列当前只显示 10 进制裸数字,用户无法分辨进制。改为同时展示两种进制,如 `17732 (0x4544)`;或列头标注"地址(10进制)"并悬浮提示 16 进制值。首选前者。
- 类型编辑器已有"16进制地址"勾选(`hexAddrCheck`),风格保持一致。

### T3. 跳过点位的 UI 呈现(高)

- 后端已在 `device:data` payload 里带 `skipped`(见背景1)。前端 `onDeviceData`(`renderer/app.js` / `renderer/device.js`)目前忽略该字段,被跳过点位显示旧值或空,用户无法区分"没数据"和"读不到"。
- 要求:被跳过的点位在值单元格显示明确标记(如 `不可读`,灰色/提示色),悬浮提示后端的 message(异常码原文);块恢复后自动回到正常显示。
- 概览卡片不需要变化。

### T4. 坏块跳过逻辑补测试(高)

`test/device-manager.test.js` 补以下用例(现有 23 个用例全过,勿破坏):

- 部分块失败:好块数据照常 emit `data`,payload 含 `skipped`,不 emit `pollError`、不离线。
- 已知坏块第二轮不再重试(read 调用次数断言)。
- 坏块恢复可读后移出坏块集合,数据恢复。
- 全部块失败:走原有 pollError → OFFLINE_THRESHOLD → offline 流程(回归)。

### T5. 原始报文发送窗体(中)

早前已确认需求:调试工作台(隐藏入口)加"原始报文发送",采用**构造请求方式**(用户在表单选 功能码/从站/地址/数量或值,软件组帧发送并显示原始 TX/RX 十六进制字节),不是自由输入裸字节。走已有设备连接(共享连接池),不要另开串口。后端加一个运行时通道(参考 `main/web-runtime.js` 的 `_handlers` 与 `WEB_RUNTIME_CHANNELS`),Electron 侧 `main/index.js` IPC 同步注册。

### T6. 异常码提示按设备类型配置(中)

重做方案(今天实现过又整体回退,原因是现场怀疑其引发写入失败——实际无关,方案本身成立):

- `main/transports/modbus-transport.js`:标准码 1~11 全局通用文案;≥12 优先查 `this.params.exceptionHints[code]`(注意 `this.params` 初始为 null 需判空),查不到给中性文案"厂商自定义异常码(0xXX):含义因设备而异,请查阅该设备通讯手册"。
- `renderer/device-config.js` 的 `buildDeviceConfig` 透传 `type.exceptionHints`。
- 类型编辑器暂不做 UI,字典先手工写 config;测试参考今天回退前的写法(git 历史无记录,按上述描述重写)。
- 海索 PCS 类型(id=`pcs_inverter_4000`)的字典内容:`{"12": "设备当前状态不允许该操作:多数参数需先关闭逆变/市电充电、切到空闲/关机状态后再写入"}`(运行配置属数据,不入库,写在文档里即可)。

### T7. 点表导入静默失败调查(低)

现象:类型编辑器「导入点表」选择合法 JSON(已验证可通过 `Codec.validatePoints`)后页面无任何反应、无红字、点位数不变(用户环境:局域网访问 Chrome)。`renderer/device.js` 523 行 `importPointsBtn.onclick` 无 try/catch,`renderer/web-api.js` `defaultPickFile` 的 focus/cancel 事件在某些浏览器可能提前 resolve null 被当作"取消"。要求:复现(可用 `options.pickFile` 注入模拟)、修复、并给导入流程加异常兜底与"已导入 N 个点位,请点保存生效"的成功提示。

### T8. 同步导出点表 JSON(低)

`~/Library/Application Support/modbusmate/config.json` 里 `dev107`(多功能双向直流电源,现 124 点,含今天修正的 17732/17733 地址与改名后的"工作模式")是最新真相,`docs/点表-多功能双向直流电源.json` 已过期。写个小脚本或手工把该类型导出覆盖到 docs/,保持 `modbusmate-points@1` 格式。

---

## 验收

- `npx vitest run` 全绿(≥546);
- 网页版实测:T1 写 4A 填 4、T2 地址双进制、T3 模式切换后跳过点有标记;
- 不改动 `main/device-manager.js` 已有跳过逻辑的语义。
