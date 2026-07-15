# ModbusMate

> **A Modbus-TCP communication debugging tool** — Read and write industrial device data (PLCs, temperature controllers, power meters, VFDs, etc.) from your computer.

[中文文档](README.zh.md) | [Report Issue](https://github.com/xmlju/ModbusMate/issues)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start](#2-quick-start)
3. [Interface Layout](#3-interface-layout)
4. [Connecting to Real Devices](#4-connecting-to-real-devices)
5. [Data Monitoring](#5-data-monitoring)
6. [Writing Data](#6-writing-data)
7. [Formula Conversion](#7-formula-conversion)
8. [Device Templates](#8-device-templates)
9. [Device Management](#9-device-management)
10. [Dashboard Overview](#10-dashboard-overview)
11. [Built-in Simulators](#11-built-in-simulators)
12. [FAQ](#12-faq)
13. [Theme Switching](#13-theme-switching)
14. [Contact & Feedback](#14-contact--feedback)

---

## 1. Overview

ModbusMate is a desktop application designed for field engineers and technicians who work with Modbus-TCP devices. No need to understand the protocol details — just enter the device IP address to view real-time data or write values.

Key features:
- **Multi-device monitoring** — Monitor multiple devices simultaneously, each displayed as a card-based dashboard
- **Data monitoring** — Poll holding registers, input registers, coils, and discrete inputs
- **Write support** — Write to coils (FC05) and registers (FC06/FC16)
- **Data type parsing** — Int16, UInt16, Int32, UInt32, Float32 (AB/BA byte order), Hex
- **Formula conversion** — Apply linear formulas (y = kx + b) to convert raw values into engineering units
- **Auto-reconnect** — Automatically retries connection every 5 seconds after 3 consecutive read failures
- **Dark/Light theme** — One-click theme switching

> **Development status:** The communication core now supports both **Modbus-TCP** and **Modbus-RTU**. RTU serial configuration accepts Windows `COM` ports and macOS `/dev/tty.*` device paths, and the serial-port enumeration IPC is complete. The browser-based UI and RTU forms on the existing pages will be connected to this core in the next phase; RTU is not yet available through the current UI.

---

## 2. Quick Start

### 2.1 Installation

**macOS**: Double-click `ModbusMate-xxx.dmg` and drag the app to the Applications folder.

**Windows**: Run `ModbusMate Setup xxx.exe` and follow the installer. Or use the portable version (`ModbusMate xxx.exe`) directly.

### 2.2 Try with Built-in Simulator (Recommended)

> ⚠️ Important: The simulator must be **started first** before ModbusMate can read data. Keep the terminal window open while using it.

**Step 1: Start a simulator**

Battery cabinet simulator (recommended, data changes dynamically):
```bash
npm run sim:bat    # Listens on port 8502
```

PLC controller simulator:
```bash
npm run sim:plc    # Listens on port 8503
```

You can run both simulators simultaneously (each in its own terminal window).

**Step 2: Connect in ModbusMate**

1. Open ModbusMate, click **「🧪 Workbench」** in the left sidebar
2. Enter IP: `127.0.0.1`, Port: `8502`, Slave ID: `1`
3. Click **「Connect」** — the status light turns green when connected
4. Select "Holding Registers", start address `0`, quantity `10`
5. Click **「Start Monitoring」** — real-time data appears in the table

### 2.3 System Requirements

- **macOS**: 10.12+
- **Windows**: 7+
- **Network**: Computer and device must be on the same network

### 2.4 Browser Debug Mode (`npm run web`)

For field debugging without building/installing the desktop app, run ModbusMate directly in a local browser tab from source:

```bash
npm install
npm run web
```

This starts a local-only HTTP server (bound to `127.0.0.1`, random port and session token) and opens your default browser to a URL like `http://127.0.0.1:8765/?token=...`. Keep the terminal open — closing it (Ctrl+C / SIGINT) shuts the service and disconnects any open device connections. Every page (Workbench, Dashboard, Device Debug, Type/Instance Manager) works exactly the same as in the Electron app, including RTU (see §4.4).

Useful environment overrides: `MODBUSMATE_WEB_PORT` (fixed port instead of random), `MODBUSMATE_DATA_DIR` (where `config.json` is stored). Pass `--no-open` to skip auto-opening a browser tab (used in CI/automated smoke tests).

> The web server only ever listens on the loopback address and requires the exact token from its own URL — it is not reachable from other devices on your network.

---

## 3. Interface Layout

### Left Sidebar (5 Pages)

| Icon | Page | Purpose |
|------|------|---------|
| 📋 | **Dashboard** | Overview of all active devices with large number cards |
| 🔧 | **Device Debug** | View detailed data points for a specific device |
| 🧪 | **Workbench** | Legacy single-device mode for direct connection |
| 📜 | **Communication Log** | Communication records for troubleshooting |
| ⚙️ | **Type/Instance Manager** | Create device templates and add device instances |

### Top Right

- **Theme toggle menu**: Switch between Dark/Light/System
- **PLC address checkbox**: Toggle address display mode

### Bottom Right

- Developer credits

![Main Interface](screenshots/main-interface.png)

---

## 4. Connecting to Real Devices

### 4.1 What You Need

1. **IP Address** — The device's network address (e.g., `192.168.1.100`)
2. **Port** — Modbus-TCP port, default is `502`
3. **Slave ID** — The device's identifier, default is usually `1`

### 4.2 Connection Steps

1. Enter the device IP in the connection bar
2. Port: `502` (default)
3. Slave ID: `1` (default)
4. Click **「Connect」**
5. Green light = connected; Red light = failed

### 4.3 Troubleshooting (TCP)

| Symptom | Possible Cause |
|---------|---------------|
| "Connection refused" | Device Modbus-TCP service not running, or wrong port |
| "No response" | Network cable unplugged, device off, wrong IP |
| "Host not found" | Wrong IP address |

### 4.4 Modbus-RTU (USB/RS485) Devices

ModbusMate also supports Modbus-RTU over a USB-to-RS485 adapter, on both the Electron app and browser debug mode (`npm run web`). One serial port is dedicated to one RTU slave.

**Steps:**

1. Plug in your USB-RS485 adapter. Set the connection bar's **Communication Method** dropdown to **RTU (USB/RS485)** — this appears on the Workbench connection bar and in the device instance dialog.
2. Click **「Refresh Serial Ports」**. Available ports are listed:
   - **macOS**: `/dev/tty.usbserial-*`, `/dev/tty.usbmodem-*` (varies by adapter chipset — FTDI, CH340, CP210x, etc.)
   - **Windows**: `COM3`, `COM4`, … (check Device Manager → Ports (COM & LPT) if the port doesn't show up — you may need the adapter's driver)
3. Set the serial parameters to match your device's protocol. Common defaults: **9600 baud, 8 data bits, no parity, 1 stop bit (9600 8N1)**, Slave ID `1`, timeout `2000ms`.
4. Click **「Connect」**.

**Wiring:** Connect the adapter's `A`/`B` (or `D+`/`D-`) terminals to the matching terminals on the device — swapped A/B is the most common cause of "no response" on an otherwise-correct RTU setup.

**Troubleshooting (RTU)**

| Symptom | Possible Cause |
|---------|---------------|
| Serial port permission denied | Another program (or a leftover ModbusMate session) holds the port; on macOS you may need to grant Terminal/App access to USB devices |
| Serial port busy | Close other serial tools (e.g. a terminal emulator, PLC config software) using the same port, then refresh |
| Port not found after unplug | Port list is stale — click **「Refresh Serial Ports」** after reconnecting the adapter |
| Communication timeout | Check A/B wiring, baud rate/parity/stop bits match the device, and the Slave ID is correct |

---

## 5. Data Monitoring

### 5.1 Configure Monitoring

1. **Area**: Select data type
   - **Holding Registers**: Read/Write (most common — settings, runtime parameters)
   - **Input Registers**: Read-only (sensor values)
   - **Coils**: ON/OFF signals, Read/Write
   - **Discrete Inputs**: ON/OFF signals, Read-only
2. **Start Address**: Starting position to read from
3. **Quantity**: Number of data points to read (max 120)
4. **Interval**: Refresh rate (100ms fastest, 10s slowest)
5. Click **「Start Monitoring」**

### 5.2 Reading the Table

Each row shows a data point:

- **Address**: Position number in the device
- **Raw Value**: Hex value from the device
- **Parsed Value**: Human-readable converted value
- **Formula**: Whether a conversion formula is applied
- **Write**: Click to write a value to this address

Rows **flash yellow** when the value changes.

---

## 6. Writing Data

### 6.1 Steps

1. Find the row you want to modify in the data table
2. Click the **「Write」** button on the right
3. Enter the value in the popup window
4. Click **「Write」** to confirm

### 6.2 Notes

- Only **Holding Registers** and **Coils** support writing
- **Input Registers** and **Discrete Inputs** are read-only
- For coils: enter `1` for ON, `0` for OFF
- After a successful write, the next polling cycle will read back the value to confirm

---

## 7. Formula Conversion

Raw device data often needs conversion. For example, a temperature sensor stores raw value 2048 but the actual temperature is 41.9°C.

### 7.1 Formula Format

```
display_value = k × raw_value + b
```

- **k** (coefficient): multiplier
- **b** (offset): adder

### 7.2 Configuration

1. Click **「Set」** in the Formula column of a data row
2. Fill in:
   - **Name**: Data point name (e.g., "Battery Temperature")
   - **Unit**: Engineering unit (e.g., `°C`, `%`, `A`, `V`)
   - **Coefficient k**: Formula multiplier
   - **Offset b**: Formula adder
   - **Decimals**: Number of decimal places to show

### 7.3 Examples

| Scenario | Raw Range | Formula | Display |
|----------|-----------|---------|---------|
| Battery 0~1000 → 0~100% | Raw: 500 | k=0.1, b=0 | **50%** |
| Temperature 0~4095 → -40~125°C | Raw: 2048 | k=0.04, b=-40 | **41.9°C** |
| Current 0~2000 → 0~200A | Raw: 1500 | k=0.1, b=0 | **150.0A** |

---

## 8. Device Templates

When you have multiple identical devices (e.g., 10 power meters), create a "Device Template" — configure once, reuse everywhere.

### 8.1 Create a Template

1. Go to **「⚙️ Type/Instance Manager」**
2. Click **「＋ New Type」**
3. Enter a template name (e.g., "Smart Meter")
4. Add data points:
   - **Name**: e.g., "Voltage", "Current"
   - **Area**: Holding Register, Input Register, etc.
   - **Address**: Position in the device
   - **Type**: "UInt16" is usually sufficient
   - **k / b**: Formula conversion (optional)
   - **Unit**: e.g., V, A, °C
5. Click Save

### 8.2 Field Reference

| Field | Description | Example |
|-------|-------------|---------|
| Name | Data point name | `Battery Voltage` |
| Area | Data region | Holding Register |
| Address | Starting position (0-based) | `0` |
| Type | Data format | UInt16, Int32, Float32 |
| k / b | Formula coefficient/offset | k=0.1, b=0 |
| Unit | Engineering unit | V, A, °C, % |

![Type/Instance Manager](screenshots/type-manager.png)

---

## 9. Device Management

### 9.1 Add a Device Instance

1. In **「⚙️ Type/Instance Manager」**, click **「＋ Add Device」**
2. Fill in:
   - **Instance Name**: Give your device a name (e.g., "Meter #1")
   - **Select Type**: Choose a template
   - **IP Address**: The device IP
   - **Port**: Usually 502
   - **Slave ID**: Usually 1
   - **Polling Interval**: How often to read data
3. Click Save

### 9.2 Start / Stop / Delete

- **Start**: Click **「Start」** — auto-connects and begins data collection
- **Stop**: Click **「Stop」** to disconnect
- **Delete**: Stop the device first, then delete

### 9.3 Status Indicators

| Light | Meaning |
|-------|---------|
| 🟢 Green | Connected, working |
| ⚪ Gray | Not started |
| 🔴 Red | Offline or connection failed |
| 🟡 Yellow | Reconnecting |

---

## 10. Dashboard Overview

After starting one or more devices, go to **「📋 Dashboard」** to see real-time data at a glance.

![Dashboard](screenshots/device-overview.png)

### 10.1 Layout

Each active device appears as a collapsible group:

- **Header**: Status light + device name + IP + online/offline label
- **Body**: Large number cards for all data points

### 10.2 Card / List View

Toggle between **Card** (large numbers, easy to read from a distance) and **List** (compact, more data visible).

### 10.3 Value Change Alerts

Cards **flash yellow** when values change. If the unit is `%` and value is 0~100, a progress bar is shown.

### 10.4 Offline Behavior

When a device disconnects, its group becomes semi-transparent with a red status light. It automatically recovers when reconnected.

---

## 11. Built-in Simulators

No real devices? Use the built-in simulators to test ModbusMate.

### 11.1 Starting a Simulator

> The simulator is a command-line program — **start it first and keep it running**.

**Battery Cabinet** (recommended, dynamic data):
```bash
npm run sim:bat
```
Generates voltage, current, temperature, and battery percentage — values change dynamically.

**PLC Controller**:
```bash
npm run sim:plc
```

**Temperature Controller**:
```bash
npm run sim:temp
```

**All three at once**:
```bash
npm run sim:all
```

### 11.2 Connect to Simulator

1. Go to **「🧪 Workbench」**
2. IP: `127.0.0.1`
3. Port: `8502` (battery), `8503` (PLC), `8504` (temp)
4. Slave ID: `1`
5. Click Connect → Start Monitoring

### 11.3 Simulator Features

| Simulator | Port | Data | Behavior |
|-----------|------|------|----------|
| Battery Cabinet | 8502 | Voltage, Current, Temperature, Battery % | Voltage drops slowly like a real battery |
| PLC Controller | 8503 | Speed, Good Count, Temperature, Runtime | Good count increases like a real production line |
| Temperature Controller | 8504 | Temperature, Humidity, Target Temp | Temperature approaches the target over time |

---

## 12. FAQ

### Q1: Can't connect to device?

Check in order:
1. `ping <device-ip>` — is the device reachable?
2. Check network cable
3. Is the device powered on?
4. Does the device support Modbus-TCP?
5. Is the port correct (default 502)?
6. Is the slave ID correct?

### Q2: Wrong values displayed?

1. Check if the data type is correct (integer vs. float)
2. Try switching byte order (AB/BA)
3. Check if the start address is correct (0-based vs. 1-based)

### Q3: "Missing next register" error?

You set a data point to a 32-bit type (e.g., float32) but the read quantity is too small. Increase the quantity.

### Q4: Write failed?

1. Only Holding Registers and Coils support writing
2. Check if the value is within range
3. Check the log for specific error messages

### Q5: Configurations lost after restart?

Configuration is stored in `config.json`. If it's corrupted, delete it while the app is closed, then restart — a new one will be created automatically.

### Q6: Device reconnected automatically?

Yes! ModbusMate auto-reconnects every 5 seconds after disconnection. No action needed.

---

## 13. Theme Switching

ModbusMate supports three themes. Click the display mode menu in the top-right corner:

| Theme | Best for |
|-------|----------|
| **🌙 Dark** | Default. Dark background, ideal for control rooms or low-light environments |
| **☀️ Light** | White background, ideal for bright environments |
| **💻 System** | Follows your system theme automatically |

Your preference is saved automatically.

---

## 14. Contact & Feedback

ModbusMate is developed and maintained by **yaomh**.

For bug reports, suggestions, or feedback:

📧 **Email**: yaomh592@gmail.com

Your feedback is appreciated — it helps make this tool better!
