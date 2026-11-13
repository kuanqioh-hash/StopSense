# CoolStop bus-stop telemetry prototype

A local prototype with a **React + TypeScript frontend**, FastAPI telemetry API, SQLite storage, and a simulated device:

```text
Python simulator → FastAPI /telemetry → SQLite → React + TypeScript (Vite)
```

Device readings are synthetic unless you connect a sensor. Arrivals at USJ 7, LRT Subang Jaya, and LRT Putra Heights are estimated from live RapidKL GTFS-Realtime vehicle positions. These are not official stop-level predictions; a clearly labeled last-known position may be used for up to 10 minutes. The API has no authentication. Its Vercel setup is for public demos with synthetic/sample data only; never use it for real operational data or advertiser contact details.

## Requirements

- Python 3.10 or later
- Node.js 20.19+ or 22.12+ and npm
- Internet access for initial package installation

## Install the backend

From this directory, create and activate a Python virtual environment, then install the backend requirements:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`.

## Run the complete demo

Open **three terminals**. Keep each process running while you use the frontend.

**Terminal 1 — FastAPI and SQLite backend** (from this directory, with the Python environment activated):

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Verify at <http://127.0.0.1:8000/health>. API documentation: <http://127.0.0.1:8000/docs>.

**Terminal 2 — simulated bus-stop device** (from this directory, with the same Python environment):

```bash
python simulator.py
```

It posts sensor readings every five seconds. Configure `DEVICE_ID`, `TELEMETRY_URL`, and `SEND_INTERVAL_SECONDS` environment variables if needed.

**Terminal 3 — React + TypeScript frontend:**

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite, usually <http://127.0.0.1:5173>. The Vite development server proxies `/api/*` requests to the FastAPI server at `127.0.0.1:8000`, so no separate CORS configuration is needed for local development. The React page receives telemetry over a live event stream and has three views: passenger app, bus-stop screen, and operations dashboard. It opens with buttons for three sample profiles (passenger, stop attendant, and operations manager); each profile can access only its assigned passenger, bus-stop screen, or operations view, and the session is saved in the current browser. This is demo-only client-side view restriction, not authentication: the API has no authentication and remains accessible independently of the selected profile. Use the header's Dark mode / Light mode control to switch themes across the dashboard; the choice is saved in this browser and initially follows the operating-system preference when no saved choice exists.

If FastAPI or the simulator is unavailable, the frontend shows clearly labelled preview values; it does not mistake these for real sensor data.

### Frontend production build

From `frontend/`:

```bash
npm run build
npm run preview
```

The development proxy only applies to `npm run dev`. Production builds read `VITE_API_URL` from `frontend/.env.production`, currently set to `https://CoolStop.onrender.com`; changing it requires rebuilding and redeploying the static site. The Vercel frontend service overrides this value at build time to use its same-domain `/api` route, without changing the existing GitHub Pages/mobile build setting. The FastAPI app allows browser requests from `https://qiphy.github.io` and the Capacitor Android/iOS origins; this is CORS configuration, not authentication. Deploy the updated backend as well as the frontend so the CORS configuration takes effect.

### Vercel multi-service demo

`vercel.json` configures two services: `frontend` (Vite, public at `/`) and `app` (FastAPI, public under `/api`). Import the repository with the project root set to `.`. The API rewrite sends `/api/*` to FastAPI. A service request-path transform strips `/api`; the FastAPI app also sets `root_path=/api` on Vercel so root-level routes continue to work if the original prefixed path reaches the runtime. The frontend build sets `VITE_API_URL=/api`. There are no service bindings because the browser calls the API through the public same-domain route; no server-side service calls exist.

This is a demo deployment. Every API endpoint is public and unauthenticated, including operations and advertiser-inquiry management. Vercel's function filesystem is temporary, so SQLite data may disappear or differ across function instances, and the in-process live telemetry stream is not a durable cross-instance channel. Passenger-counter history can be made durable in Supabase as described below, but that does not make other telemetry or operations data durable or make this public API production-ready. Do not enter real advertiser contact details or rely on the unauthenticated demo for operational use; production use needs server-side authentication, authorization, and abuse protection.

#### Persistent passenger-counter history (Supabase)

Run [`supabase_passenger_counts.sql`](supabase_passenger_counts.sql) in the Supabase project's SQL Editor. In the environment settings for the FastAPI backend (currently `CoolStop.onrender.com` on Render; use the Vercel API service if that is the deployed backend), set `SUPABASE_URL` to the project URL and `SUPABASE_SERVICE_ROLE_KEY` to that project's service-role secret, then redeploy the backend. Never use a `VITE_` prefix for the service-role key and never expose it in browser code. The key is server-only and grants broad database access. Keep RLS enabled and do not add public or authenticated-user policies for these tables unless the access model is redesigned.

When the webcam counter starts, it opens a session and stores an initial snapshot, then stores a snapshot when counts change and at least every 30 seconds; stopping saves a final snapshot and closes the session. Operations displays recent sessions and their latest counts. Only aggregate numbers and timestamps are uploaded; video remains in the browser. The existing `/passenger-counts` endpoint still provides the latest per-camera report. Local development uses SQLite; without Supabase configured, the website warns that persistent history is unavailable. Session history is retained until you delete it from Supabase.

### Android and iOS apps

The React frontend can also be packaged as native Android and iOS apps with Capacitor. The generated Android and Xcode projects are in `frontend/android` and `frontend/ios`; the app bundles the built frontend and connects to the hosted API configured in `frontend/.env.production`.

From `frontend/`, install dependencies and sync the web build into the native projects:

```bash
npm install
npm run mobile:sync
```

For a locally installable Android debug APK, install Android Studio and the Android SDK, then run:

```bash
npm run android:debug
```

The APK is written to `frontend/android/app/build/outputs/apk/debug/app-debug.apk`. For a Play Store or distributable release, open Android Studio with `npm run android:open` and use **Build > Generate Signed Bundle / APK** with your own release signing key.

For iOS, use a Mac with Xcode. Open the synced project with `npm run ios:open`, select your Apple development team and signing settings, then use Xcode's **Product > Archive** workflow to export an IPA. A valid Apple signing identity and provisioning profile are required to install or distribute an iPhone build; those are not included in this repository.

Camera use is declared in both native projects. Validate camera permission prompts, the TensorFlow.js person detector, and the live API connection on real devices. Capacitor's Android and iOS origins are allowed by the local FastAPI CORS configuration; deploy that backend change before testing against the hosted API. The backend has no authentication and is suitable only for synthetic/demo data on a public host; add authentication and other production safeguards before handling real data.

### Contextual advertising prototype

Passenger and bus-stop-screen views request campaign recommendations from `GET /advertisements/recommendations` using the selected stop, dashboard route, crowd estimate, temperature, Kuala Lumpur local time, and editable stop profiles. If no active campaign matches the current context, the API returns one active campaign as a general fallback; if no campaigns are active, no ad is shown. Operations can create, edit, pause, or delete campaigns; maintain each stop's facility tags/radius/optional coordinates; and review placement inquiries and update their status. A placement inquiry form appears beneath passenger-facing ads. Fresh camera-count changes are accumulated by route and local hour in SQLite and contribute a relative busy-period score; the source is a limited aggregate estimate, not a comprehensive traffic history. Temperature targeting is supported, but no external weather or nearby-place lookup is connected. Facility relevance comes from manually maintained stop tags; stored radius and coordinates are not used to calculate real nearby buildings.

API operations include `GET/POST /advertisements`, `PUT/DELETE /advertisements/{id}`, `GET /stop-ad-profiles`, `PUT /stop-ad-profiles/{stop_id}`, `POST /advertisement-inquiries`, `GET /advertisement-inquiries`, and `PATCH /advertisement-inquiries/{id}`. The database is initialized with clearly labeled demo campaigns when it has none.

**Security and privacy:** the demo API has no authentication. The Operations view is only hidden by client-side sample-account selection, and the management endpoints (including inquiry records and email addresses) are publicly accessible wherever the API is exposed. The Vercel configuration exposes these endpoints for demo data only. Do not collect real advertiser contact details or operational data until server-side authentication, authorization, abuse protection, privacy controls, and durable storage are implemented. Deploy the updated backend and frontend together to use the feature.

### Solar generation and reference energy use

The dashboard shows illustrative reference load values from the supplied system reference: a 120 W centrifugal fan (assumed 12 h/day), 20 W LED lighting (14 h/day), and 15 W controls + sensors (12 h/day), for a 155 W total rated load and 1.90 kWh/day example consumption. The reference also lists a 0 W gravity-fed pump, 57 kWh/month, 694 kWh/year, RM 315/year at RM 0.454/kWh, and 526 kgCO₂e/year. These are reference assumptions, not site measurements or verified equipment performance.

The reference does **not** provide a separate display wattage: 15 W is labelled “Controls + Sensors” and must not be treated as a confirmed display rating. Solar generation/output is intentionally shown as awaiting panel specifications. Do not infer generation, system sizing, or dimension-based estimates until engineering provides panel specifications and a measurement source.

### Live dashboard updates

The frontend opens a Server-Sent Events connection to `GET /events/telemetry`. The API sends an initial telemetry/passenger-count snapshot and pushes a refreshed snapshot when either ingestion endpoint receives data. EventSource reconnects automatically; bus arrival countdowns continue to update locally each second. The development proxy forwards `/api/events/telemetry` to FastAPI. For a hosted split frontend/backend, set `VITE_API_URL` to the backend base URL and allow the frontend origin in the API CORS configuration.

### RapidKL transit data

The passenger, stop-screen, and operations views can select **USJ 7 · SJ693 LRT USJ 7**, **LRT Subang Jaya**, or **LRT Putra Heights**. At all three stations, the backend first matches live GTFS-Realtime vehicle positions to static GTFS trips and route geometry to estimate arrivals at the selected stop: `1006526` (SJ693), `1006524` (SJ63 LRT SUBANG JAYA), and `1006550` (SJ705 LRT PUTRA HEIGHT). These GPS-based estimates are not official stop-level predictions. The backend retains the most recent position per vehicle in memory; if a vehicle is absent from a new feed or the feed is temporarily unavailable, it can use that last-known position for up to 10 minutes. Such estimates are labeled with the age of the last GPS position, and older positions are discarded. If no usable live estimate is available, the app falls back to the next active trips in the RapidKL static GTFS schedule and labels them as scheduled; actual arrival times may differ. Calendar exceptions, trips continuing past midnight, and frequency-based service windows are accounted for. The dashboard also displays the complete static timetable for the selected stop and current local day—even when live estimates are available—marking past trips and labeling non-exact frequency-based times as approximate. Gaps in the feed are not filled in or represented as hourly service. Static GTFS is cached for 24 hours and live position data for 25 seconds. `GET /transit/stops` lists station metadata and `GET /transit/departures?station_id=usj7` (or `subang-jaya` / `putra-heights`) returns live estimates or the next scheduled arrivals in `departures`, plus the day’s complete static schedule in `timetable`.

The static feed is licensed CC BY 4.0; attribution: “Transit data: RapidKL/Prasarana via data.gov.my GTFS.” See the [Data.gov.my GTFS Static API](https://developer.data.gov.my/realtime-api/gtfs-static). Deploy the updated FastAPI backend and frontend together. The API identifies the response source so the interface distinguishes GPS-based arrival estimates from static scheduled times.

Passenger view still includes a hands-free two-ad carousel that slides between time-based sample nearby-shop offers every 15 seconds, expandable shop details, sample walk/bus/alight directions, locally generated QR codes for demo voucher and route links, a location-permission prompt, sample disruption alternatives, and a comparison of fictional e-hailing providers. The non-touchscreen stop display rotates two sample ad slides automatically every 15 seconds. QR scans reopen the demo app and display a prototype notice; voucher redemption, map navigation and live service data are not integrated. No user location is stored or sent to the API; location access is only requested after the user presses the button. The demo does not use coordinates for routing: even after permission is granted, the sample alternatives are still based on the selected stop until an approved map/transit routing source is integrated.

The disruption control is a local simulation, not a real disruption feed. Alternative bus routes, fare estimates, pickup ETAs and vehicle types are fictional examples. Selecting “continue” does not place an order or contact a provider. Public transport alternatives are shown first; real multi-provider quotes and booking require each e-hailing company's agreement and API integration. Shop names/offers are also fictional and do not imply a partnership. Crowd level means people waiting at the stop, **not occupancy onboard a bus**.

## Arduino Uno or ESP32 + SHT31 over USB

Both supported boards use the same sketch and Python USB-serial bridge: the board sends readings over USB to a computer, and the bridge forwards them to FastAPI. The Uno has no Wi-Fi; the ESP32 could send directly over Wi-Fi with a separately configured firmware, but this shared path does not need Wi-Fi credentials on either board. Keep the computer and API reachable while the bridge runs.

**Wire the SHT31 breakout with board power disconnected.** For Uno, SDA is A4 and SCL is A5. For a typical ESP32 DevKit, SDA is GPIO21 and SCL is GPIO22; check the pinout for your exact ESP32 board and change `SHT31_SDA_PIN` / `SHT31_SCL_PIN` at the top of the sketch if needed. Connect GND to GND and VIN/VCC only to a voltage supported by the breakout. ESP32 GPIO is 3.3 V only: ensure I2C pull-ups are to 3.3 V and do not connect a 5 V pull-up to ESP32 pins. The default I2C address in the sketch is `0x44`.

In Arduino IDE, install the board support package for your board (Arduino AVR Boards for Uno or Espressif ESP32), select the exact board and USB port, install **Adafruit SHT31 Library** (including its prompted dependencies), then open `arduino/SHT31USB/SHT31USB.ino` and upload it. The ESP32 code sets default I2C pins to 21/22; some ESP32 variants use different pins. Both boards emit the same `SHT31,<temperature C>,<relative humidity %>` records at 115200 baud every five seconds. If the sensor is not found, check wiring, configured pins, and I2C address; the sketch reports an error and retries.

Install the serial bridge dependencies and start FastAPI as described above. In another terminal from the project root, set the board's USB serial port and run the same command for either board:

```bash
python -m pip install -r requirements-arduino.txt
python arduino_serial_bridge.py --port /dev/cu.usbmodem1101 --api-url http://127.0.0.1:8000/telemetry --device-id USJ7
```

Replace the example port with the Uno's port shown in Arduino IDE (**Tools > Port**); macOS ports commonly begin `/dev/cu.usbmodem`, Windows ports look like `COM3`, and Linux ports commonly look like `/dev/ttyACM0`. The bridge also accepts `SERIAL_PORT`, `TELEMETRY_URL`, and `DEVICE_ID` environment variables. Close Arduino IDE's Serial Monitor before running the bridge because only one process can use the serial port at a time. Stop it with Ctrl+C.

For a hosted API, pass its full telemetry endpoint using `--api-url`, for example `https://your-api.example/telemetry`. The API must be reachable from the computer running the bridge, and the frontend must point at that same backend to display its readings. This demo API has no authentication; do not expose it publicly without adding authentication and deployment safeguards. The bridge sends temperature and humidity; water level, power, and cooler state are stored as `null` and shown as not reported, rather than fabricated.

## Arduino solar-panel voltage on the dashboard

The supplied `arduino/solarpanel.py/solarpanel.py.ino` sketch prints `Solar Panel Voltage: <volts> V` at 9600 baud. The Python bridge now recognizes those lines, derives the sketch's four voltage status labels, and posts each reading to `/telemetry/solar`; the live dashboard shows voltage, status, device ID, and update time. Use an Uno-compatible board for this sketch as written: it assumes a 5 V reference, 10-bit ADC, analog pin A0, and a 2:1 voltage divider. **Do not connect a panel directly to A0 if its voltage can exceed the board's analog input limit.** Use a correctly rated divider, common ground, and confirm the panel's maximum open-circuit voltage and board input limit before powering it. The bridge does not calculate watts or energy; that requires measuring current too.

Upload the solar sketch, close Arduino IDE's Serial Monitor, then run the bridge with the board port and the exact device ID used for the stop in the dashboard:

```bash
python -m pip install -r requirements-arduino.txt
python arduino_serial_bridge.py --port /dev/cu.usbmodem1101 --baud 9600 --api-url https://your-api.example/telemetry --device-id USJ7
```

For local FastAPI, replace the API URL with `http://127.0.0.1:8000/telemetry`. The frontend must use the same backend, and both backend and frontend need deployment for the hosted dashboard to receive and display the new readings. The bridge retains its 115200 baud default for the existing SHT31/StopSense sketches; pass `--baud 9600` for this solar sketch.

## Combined ESP32/Uno SHT31 + LD2410C dashboard telemetry

`arduino/StopSenseESP32/StopSenseESP32.ino` combines the SHT31 temperature/humidity sensor with LD2410C presence detection and emits `STOPSENSE,<temperature C>,<humidity %>,<crowd level>` over USB serial every five seconds. On ESP32 it uses the LD2410C engineering-mode UART estimate: no target maps to `Low`, a target with fewer than six active distance gates maps to `Moderate`, and six or more active gates maps to `High`. On Uno it uses the sensor's digital `OUT` pin: `CLEAR` maps to `Low` and `PRESENT` maps to `High` (no `Moderate`). The bridge posts the crowd level with `crowd_source: sensor`. Neither method is a verified people count.

Wire with power disconnected. **For ESP32:** connect SHT31 SDA/SCL to GPIO12/13 (matching the current `SHT31USB` ESP32 sketch), sensor GND to ESP32 GND, and sensor VCC only to a voltage supported by its breakout; ensure I2C pull-ups are 3.3 V, not 5 V. GPIO12 is a boot-strapping pin on classic ESP32 boards; if it prevents boot, use GPIO21/22 and change `SHT31_SDA_PIN` / `SHT31_SCL_PIN`. Connect LD2410C `UART_TX` to GPIO25 (UART RX), `UART_RX` to GPIO26 (UART TX), and share GND; power it from 5 V with adequate supply capacity. UART uses 256000 baud internally. **For Uno:** connect SHT31 SDA to A4 and SCL to A5, and connect LD2410C `OUT` to D2; share GND and power the radar from 5 V with adequate supply capacity. Leave the LD2410C UART pins disconnected. The board's built-in LED indicates radar `HIGH`/`PRESENT`; on ESP32 it uses the one-second HIGH stability filter, while on Uno it follows the digital presence output.

In Arduino IDE, select either an ESP32 board or Uno and its USB port, install **Adafruit SHT31 Library**, then open and upload `arduino/StopSenseESP32/StopSenseESP32.ino`. The sketch selects the appropriate sensor path for the selected board. SHT31 read failures are reported and retried; missing/stale ESP32 radar data yields `Unknown`. The bridge accepts both this combined record and the legacy `SHT31` record. Close Serial Monitor before starting it. For the live dashboard, use the deployed backend endpoint:

```bash
python -m pip install -r requirements-arduino.txt
python arduino_serial_bridge.py --port /dev/cu.usbserial-0001 --api-url https://CoolStop.onrender.com/telemetry --device-id USJ7
```

Replace the sample port with the board's USB port shown in Arduino IDE. Keep the computer and internet connection available while the bridge runs. The StopSense frontend must use that same backend URL to display incoming readings. The backend's public demo API has no authentication, so use only its intended demo deployment; do not expose a new API publicly without authentication and deployment safeguards.

## Arduino Uno water-level sensor

`arduino/StopSenseUnoWaterLevel/StopSenseUnoWaterLevel.ino` is for an Uno with the project's SHT31, LD2410C, solar-divider, and a common three-wire analog water-level module. With power disconnected, connect water-sensor `AO`/`SIG` to **A1**, `GND` to Uno `GND`, and `VCC` to a voltage supported by that sensor board (commonly 3.3–5 V). Keep its signal within the Uno's 0–5 V analog-input range. The sketch reserves A0 for the solar-panel divider, A4/A5 for SHT31 I2C, D2 for LD2410C `OUT`, and D13 for the status LED. Use a common ground. For a resistive probe left in water continuously, power it only while sampling or use a sensor designed to resist corrosion; continuous excitation can corrode exposed electrodes.

The sketch emits combined `STOPSENSE,temp_c,humidity_pct,crowd_level,water_level_pct` records at 115200 baud and the solar-voltage line at the same interval. The bridge accepts the water percentage and posts it to `/telemetry`; the Operations dashboard's **Water remaining** metric displays it and flags values below 20% for refill. Install the **Adafruit SHT31 Library** and upload this sketch to the Uno instead of the separate solar or combined sensor sketch. Start the bridge with the same 115200-baud command above.

The water percentage must be calibrated for the actual sensor and tank. Temporarily open Serial Monitor at 115200 baud and record `Water sensor raw ADC` with the sensor at empty and full. Set `WATER_LEVEL_EMPTY_ADC` and `WATER_LEVEL_FULL_ADC` near those readings in the sketch, upload again, then close Serial Monitor before starting the bridge. Defaults are placeholders and do not represent a calibrated tank level. If the sensor is a float switch, digital module, or uses different pins rather than an analog `AO` output, this sketch's wiring and calibration do not apply.

## Standalone LD2410C presence monitor

`arduino/LD2410C/LD2410C.ino` is a separate test sketch for the LD2410C's digital `OUT` pin. It supports an Arduino Uno (default input pin D2) and a typical ESP32 DevKit (default GPIO27), prints `LD2410C,PRESENT` or `LD2410C,CLEAR` to the Serial Monitor at 115200 baud immediately and then every five seconds, and lights the board's built-in LED while presence is detected when that board defines `LED_BUILTIN`. It does not modify the SHT31 sketch, send data to the API/dashboard, or control fans/lights. Upload this sketch instead of the SHT31 sketch when testing the presence sensor.

With the board powered off, connect LD2410C VCC to 5 V, GND to board GND, and `OUT` to the sketch's input pin (D2 on Uno or GPIO27 on ESP32). The sensor and board must share ground. Hi-Link's LD2410C manual specifies a 3.3 V `OUT` logic level, so it can connect directly to ESP32 GPIO27; if your particular breakout differs, verify its output voltage before wiring. Leave UART_TX/UART_RX disconnected for this simple digital-output monitor.

In Arduino IDE, select the Uno or ESP32 board and its USB port, open `arduino/LD2410C/LD2410C.ino`, upload, then open Serial Monitor at 115200 baud. Move into and out of the sensor's detection area; the LED follows presence changes, and the current status is printed immediately and every five seconds. To use another input pin, change the board-specific `LD2410C_OUT_PIN` default near the top of the sketch. If your board's built-in LED is active-low, set `LD2410C_LED_ACTIVE_LOW` to `1`.

### Set the LD2410C maximum range (ESP32 only)

`arduino/LD2410C_SetRange/LD2410C_SetRange.ino` is a separate one-time ESP32 setup sketch. It sets both motion and stationary maximum distance gates to gate 2 (about 1.5 m) and preserves the existing no-presence delay. This is an approximate radial detection limit, not an exact perimeter; the sensor cannot define a polygon or reliably count individual people. Its smallest supported maximum-range setting is 1.5 m.

With power disconnected, wire sensor `UART_TX` to ESP32 GPIO25 (UART RX), sensor `UART_RX` to ESP32 GPIO26 (UART TX), and connect sensor GND to ESP32 GND. Power the LD2410C from 5 V with adequate supply capacity; keep `OUT` wired as described above if you also want to monitor presence. In Arduino IDE, select an ESP32 board, open and upload the setup sketch, and check Serial Monitor at 115200 baud for a success message. The sketch communicates over UART at 256000 baud. If using other pins, define `LD2410C_UART_RX_PIN` and `LD2410C_UART_TX_PIN` before the defaults in the sketch.

After a successful configuration, power off the sensor, disconnect the UART wires, then upload the standalone monitor sketch. The range setting is stored in the sensor. This configurator is ESP32-only because Uno does not provide a hardware UART suitable for the LD2410C's 256000-baud interface.

### Experimental occupancy estimate (ESP32 only)

`arduino/LD2410C_OccupancyEstimate/LD2410C_OccupancyEstimate.ino` reads engineering-mode UART data and prints `EMPTY`, `LOW`, or `HIGH` every five seconds. Its status LED lights for a `HIGH` state and turns off for `LOW`, `EMPTY`, or stale/missing data. To reduce flicker when gate counts fluctuate around the threshold, LED state changes only after the requested state stays stable for 1 second; stale/missing data turns it off immediately. The sketch uses `LED_BUILTIN` when available, otherwise GPIO2; override `LD2410C_STATUS_LED_PIN` if your ESP32 board uses a different LED pin, and set `LD2410C_LED_ACTIVE_LOW` to `1` for an active-low LED. Connect sensor `UART_TX` to ESP32 GPIO25 (UART RX), sensor `UART_RX` to ESP32 GPIO26 (UART TX), and share GND; the ESP32's USB Serial Monitor remains at 115200 baud while the sensor UART runs at 256000 baud. The sketch enables engineering mode at startup. To return to the usual output mode, power-cycle the sensor.

This is only an experimental signal-level heuristic, not a people counter: it reports `EMPTY` when the sensor has no target, `LOW` for an active target with 1–5 distance gates at energy 20 or higher, and `HIGH` for 6 or more such gates. One person can activate many gates through movement and reflections, while several people can overlap, so these categories do not correspond to a number of people. Tune `ACTIVE_GATE_ENERGY_THRESHOLD` and `HIGH_GATE_COUNT` only through testing in your specific space; the Uno's digital `OUT`-only setup cannot provide the UART data this estimate needs.

## Shared ESP32/FastAPI payload

The simulator and USB serial bridge send this schema to `POST /telemetry`. Firmware with network access (for example, an ESP32 program using Wi-Fi) can send the same JSON using HTTP POST with `Content-Type: application/json`; the shared SHT31 sketch in this project uses USB serial instead:

```json
{
  "device_id": "USJ7",
  "timestamp": "2026-10-19T08:30:00+00:00",
  "temperature_c": 31.2,
  "humidity_pct": 72.0,
  "water_level_pct": 85.0,
  "power_w": 14.6,
  "cooler_on": true,
  "crowd_level": "Moderate",
  "crowd_source": "simulated",
  "fault_code": null
}
```

The API validates values and returns HTTP `201` for accepted data or `422` for invalid fields. `crowd_level` accepts `Low`, `Moderate`, `High`, or `Unknown`; `crowd_source` identifies `simulated`, `manual`, `sensor`, `operator`, or `unknown` data; omitted sources default to `unknown`. Read recent records at `GET /telemetry?limit=200`; filter by device with `GET /telemetry?device_id=USJ7`.

For real deployment, only report a stop crowd level from a verified source (for example manual observation or an approved people-counting sensor), with a timestamp and source label. GPS on buses does not provide occupancy. The local doorway counter below estimates onboard occupancy from observed crossings; it does not measure the waiting crowd and is not a substitute for a validated passenger-counting system.

### Local doorway passenger counter (boarding/alighting/occupancy)

The Operations view keeps the CoolStop dashboard and telemetry intact. Its browser webcam counter adapts CrowdCounter1’s TensorFlow.js COCO-SSD (`mobilenet_v2`) person detector, confidence filtering, bounding-box center tracking, a configurable horizontal/vertical counting line, direction selection, and crossing safeguards (multiple observations, minimum travel distance, and per-track cooldown). It does not automatically recognize the bus door: start the camera, select **Mark doorway area**, then drag a rectangle over the physical doorway that includes the counting line. A highlighted box shows the calibrated area; boarding/alighting crossings outside it are ignored, and counts remain paused until the area is marked. Calibration is saved locally in that browser for each selected camera, not uploaded to the server. Each tracked person is counted independently, so multiple people crossing in one frame increment the totals by the number of tracks that crossed. The local preview shows `Detected now` (people in the latest processed frame) and `Total detected` (new track IDs created since the camera was started); the total is an approximate track count, not a guaranteed unique-person count, and a lost track may cause the same person to be counted again. Track IDs associate detections based on movement and proximity only; they do not verify identity. Person boxes and track IDs are drawn over the local preview. This browser path does not use YOLO. Camera video stays in the browser and only aggregate reports are posted to `POST /passenger-counts` and, when configured, timestamped session snapshots to `POST /passenger-count-sessions`. The browser counter requires a secure page (HTTPS or localhost) and camera permission. Choose a bus route in the controls; reports are associated with that route and appear in Operations. These doorway crossings estimate boarding/alighting and onboard occupancy; they do not measure the crowd waiting at the stop.

A separate optional Python counter is available for a camera host and uses Ultralytics YOLOv8n + ByteTrack. It can be used instead of the browser counter; it is not loaded or run by the browser. On the computer connected to the camera, install the optional camera dependencies from the CoolStop project root:

```bash
python -m pip install -r requirements-camera.txt
```

Start FastAPI in one terminal:

```bash
uvicorn main:app --reload
```

In a second terminal on that host, run the counter (choose the route in the Operations setup panel and pass the same route here):

```bash
python bus_counter.py --source 0 --camera-id bus-door-01 --bus-route T1 --axis y --line 0.55 --in-direction down
```

For a side-on view, use `--axis x --in-direction right`; change the direction if necessary and validate it with a short test. Adjust `--line` to the camera view. Use `--source path/to/video.mp4` for a recorded test or `--source URL` for a camera stream. Configure the model with `--model` (default `yolov8n.pt`), detection threshold with `--confidence`, tracker with `--tracker` (default `bytetrack.yaml`), and line-jitter tolerance with `--hysteresis`. The model weights download on first run unless a local model path is supplied. Set `--initial-occupancy N` to seed an area that is not empty. Crossing safeguards can be tuned with `--min-displacement`, `--min-track-frames`, and `--crossing-cooldown`. `--api-url ""` disables publishing and `--no-display` runs headlessly. `PASSENGER_COUNT_API_URL`, `PASSENGER_CAMERA_ID`, `PASSENGER_BUS_ROUTE`, and `PASSENGER_MODEL` can also configure these values.

Frames are processed locally and never uploaded. The API stores the latest aggregate report per camera; boarding, alighting, and occupancy values are cumulative/estimated for that counter process. Reports marked `ok` are shown as stale after 30 seconds without an update. Detector confidence is the mean model score for counted crossings, not calibrated counting accuracy. The passenger view may display the latest route-associated onboard occupancy estimate; it is not an estimate of the people waiting at the stop and does not account for people already onboard unless the initial occupancy is set appropriately.

Stop waiting-area crowd telemetry remains its own data path (`crowd_level`/`crowd_source`) and must come from an appropriate stop-side source. Bus doorway crossings do not measure people waiting at the stop, and occupancy can drift due to missed detections, track swaps, or unobserved entry/exit. This is a prototype, not certified passenger-counting equipment. Validate and tune the model, line, direction, and tracking on the actual camera angle; only use camera footage with operator approval, appropriate notices/consent, and a privacy review. Do not use facial recognition or retain identifiable footage.

The API accepts aggregate reports at `POST /passenger-counts`; `occupancy_count` remains nullable for older counter clients, and `bus_route` is optional. Retrieve reports with `GET /passenger-counts` or filter with `GET /passenger-counts?camera_id=bus-door-01`.

Validate crossing logic without a camera or optional CV packages:

```bash
python bus_counter.py --self-test
python -m unittest test_passenger_counts.py test_transit_gtfs.py
```

By default, the SQLite file is `telemetry.db` in the current directory. Set `TELEMETRY_DB` to change its path.

## ESP32 direct Wi-Fi option

The shared SHT31 sketch above uses USB serial on both Uno and ESP32, with the Python bridge handling internet/API communication. If you later implement direct ESP32 Wi-Fi posting, keep the same FastAPI payload contract and point it at the computer's LAN address for local tests (for example `http://192.168.1.20:8000/telemetry`, not `localhost`, which refers to the ESP32 itself). For public deployment, use HTTPS with certificate validation, device authentication, access control, retention limits, and robust offline buffering. Never disable TLS certificate checks. Keep safety-critical cooling control on the ESP32; the dashboard/server should monitor it, not be required for safe operation.
