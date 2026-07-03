# ModbusMate

> 通用 Modbus-TCP 调试工具：轮询监控 · 单点写入 · 数据类型解析（Windows / Mac 桌面应用）

## 功能

- **轮询监控**：连接任意 Modbus-TCP 设备（FC01–FC04 四区域），按周期实时刷新表格，数值变化高亮
- **指令下发**：线圈 FC05、寄存器 FC06（32 位类型自动用 FC16 写两个寄存器），写后立即回读确认
- **数据解析**：Int16 / UInt16 / Int32 / UInt32 / Float32（AB/BA 字序）/ Hex，每行独立设置
- **地址模式**：PLC 习惯地址（40001 起）与协议地址（0 起）一键切换
- **断线重连**：连续 3 次读失败自动进入重连，每 5 秒重试，恢复后继续监控
- **激活授权**：激活码 + 设备绑定 + 服务端验证（30 天 Token 本地验签，7 天断网宽限）

## 开发

```bash
npm install          # 安装依赖
npm run dev          # 开发模式启动（MM_DEV=1 跳过激活）
npm test             # 单元测试（codec/poller/service/activation）
npm run sim          # 启动本地 Modbus-TCP 模拟从站（127.0.0.1:8502）
npm run dist         # 打包（Mac 出 dmg；Windows 上运行出 NSIS + 便携版）
```

## 激活服务

服务端代码在 `scf/`（腾讯云 SCF，主节点）与 `workers/`（Cloudflare Worker，备用节点），部署方法与密钥配置见 `docs/plans/2026-07-03-modbusmate-impl.md` Task 14。

生成激活码：`MM_SECRET=<密钥> node scripts/generate-codes.js 100`（输出 codes.txt，已被 gitignore）

## 文档

- 设计规格：`docs/specs/2026-07-03-modbusmate-design.md`
- 实施计划：`docs/plans/2026-07-03-modbusmate-impl.md`
