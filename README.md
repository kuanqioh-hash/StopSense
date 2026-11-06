# CoolStop bus-stop telemetry prototype

A local prototype with a **React + TypeScript frontend**, FastAPI telemetry API, SQLite storage, and a simulated device:

```text
Python simulator → FastAPI /telemetry → SQLite → React + TypeScript (Vite)
```

Device readings are synthetic unless you connect a sensor. Arrivals at USJ 7, LRT Subang Jaya, and LRT Putra Heights are estimated from live RapidKL GTFS-Realtime vehicle positions. These are not official stop-level predictions; a clearly labeled last-known position may be used for up to 10 minutes. The API has no authentication and is intended for local demonstration only; do not expose it to the public internet.

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

The development proxy only applies to `npm run dev`. Production builds read `VITE_API_URL` from `frontend/.env.production`, currently set to `https://CoolStop.onrender.com`; changing it requires rebuilding and redeploying the static site. The FastAPI app allows browser requests from `https://qiphy.github.io` and the Capacitor Android/iOS origins; this is CORS configuration, not authentication. Deploy the updated backend as well as the frontend so the CORS configuration takes effect.

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

Camera use is declared in both native projects. Validate camera permission prompts, the TensorFlow.js person detector, and the live API connection on real devices. Capacitor's Android and iOS origins are allowed by the local FastAPI CORS configuration; deploy that backend change before testing against the hosted API. The backend currently has no authentication and is a demonstration service, so do not publish it for public use without adding authentication and other production safeguards.

### Solar generation and reference energy use

The dashboard shows illustrative reference load values from the supplied system reference: a 120 W centrifugal fan (assumed 12 h/day), 20 W LED lighting (14 h/day), and 15 W controls + sensors (12 h/day), for a 155 W total rated load and 1.90 kWh/day example consumption. The reference also lists a 0 W gravity-fed pump, 57 kWh/month, 694 kWh/year, RM 315/year at RM 0.454/kWh, and 526 kgCO₂e/year. These are reference assumptions, not site measurements or verified equipment performance.

The reference does **not** provide a separate display wattage: 15 W is labelled “Controls + Sensors” and must not be treated as a confirmed display rating. Solar generation/output is intentionally shown as awaiting panel specifications. Do not infer generation, system sizing, or dimension-based estimates until engineering provides panel specifications and a measurement source.

### Live dashboard updates

The frontend opens a Server-Sent Events connection to `GET /events/telemetry`. The API sends an initial telemetry/passenger-count snapshot and pushes a refreshed snapshot when either ingestion endpoint receives data. EventSource reconnects automatically; bus arrival countdowns continue to update locally each second. The development proxy forwards `/api/events/telemetry` to FastAPI. For a hosted split frontend/backend, set `VITE_API_URL` to the backend base URL and allow the frontend origin in the API CORS configuration.

### RapidKL transit data

The passenger, stop-screen, and operations views can select **USJ 7 · SJ693 LRT USJ 7**, **LRT Subang Jaya**, or **LRT Putra Heights**. At all three stations, the backend matches live GTFS-Realtime vehicle positions to static GTFS trips and route geometry to estimate arrivals at the selected stop: `1006526` (SJ693), `1006524` (SJ63 LRT SUBANG JAYA), and `1006550` (SJ705 LRT PUTRA HEIGHT). These GPS-based estimates are not official stop-level predictions. The backend retains the most recent position per vehicle in memory; if a vehicle is absent from a new feed or the feed is temporarily unavailable, it can use that last-known position for up to 10 minutes. Such estimates are labeled with the age of the last GPS position, and older positions are discarded. Static GTFS is cached for 24 hours and live position data for 25 seconds. `GET /transit/stops` lists station metadata and `GET /transit/departures?station_id=usj7` (or `subang-jaya` / `putra-heights`) returns live-position estimates.

The RapidKL feed is licensed CC BY 4.0; attribution: “Transit data: RapidKL/Prasarana via data.gov.my GTFS.” Deploy the updated FastAPI backend and frontend together. If the live feed is unreachable but a matching vehicle position from the past 10 minutes is cached, the dashboard uses it and shows its age; without an eligible position, it reports that a live arrival estimate is unavailable rather than showing a scheduled time as an ETA.

Passenger view still includes a hands-free two-ad carousel that slides between time-based sample nearby-shop offers every 15 seconds, expandable shop details, sample walk/bus/alight directions, locally generated QR codes for demo voucher and route links, a location-permission prompt, sample disruption alternatives, and a comparison of fictional e-hailing providers. The non-touchscreen stop display rotates two sample ad slides automatically every 15 seconds. QR scans reopen the demo app and display a prototype notice; voucher redemption, map navigation and live service data are not integrated. No user location is stored or sent to the API; location access is only requested after the user presses the button. The demo does not use coordinates for routing: even after permission is granted, the sample alternatives are still based on the selected stop until an approved map/transit routing source is integrated.

The disruption control is a local simulation, not a real disruption feed. Alternative bus routes, fare estimates, pickup ETAs and vehicle types are fictional examples. Selecting “continue” does not place an order or contact a provider. Public transport alternatives are shown first; real multi-provider quotes and booking require each e-hailing company's agreement and API integration. Shop names/offers are also fictional and do not imply a partnership. Crowd level means people waiting at the stop, **not occupancy onboard a bus**.

## Arduino Uno or ESP32 + SHT31 over USB

Both supported boards use the same sketch and Python USB-serial bridge: the board sends readings over USB to a computer, and the bridge forwards them to FastAPI. The Uno has no Wi-Fi; the ESP32 could send directly over Wi-Fi with a separately configured firmware, but this shared path does not need Wi-Fi credentials on either board. Keep the computer and API reachable while the bridge runs.

**Wire the SHT31 breakout with board power disconnected.** For Uno, SDA is A4 and SCL is A5. For a typical ESP32 DevKit, SDA is GPIO21 and SCL is GPIO22; check the pinout for your exact ESP32 board and change `SHT31_SDA_PIN` / `SHT31_SCL_PIN` at the top of the sketch if needed. Connect GND to GND and VIN/VCC only to a voltage supported by the breakout. ESP32 GPIO is 3.3 V only: ensure I2C pull-ups are to 3.3 V and do not connect a 5 V pull-up to ESP32 pins. The default I2C address in the sketch is `0x44`.

In Arduino IDE, install the board support package for your board (Arduino AVR Boards for Uno or Espressif ESP32), select the exact board and USB port, install **Adafruit SHT31 Library** (including its prompted dependencies), then open `arduino/SHT31USB/SHT31USB.ino` and upload it. The ESP32 code sets default I2C pins to 21/22; some ESP32 variants use different pins. Both boards emit the same `SHT31,<temperature C>,<relative humidity %>` records at 115200 baud every five seconds. If the sensor is not found, check wiring, configured pins, and I2C address; the sketch reports an error and retries.

Install the serial bridge dependencies and start FastAPI as described above. In another terminal from the project root, set the board's USB serial port and run the same command for either board:

```bash
python -m pip install -r requirements-arduino.txt
python arduino_serial_bridge.py --port /dev/cu.usbmodem1101 --api-url http://127.0.0.1:8000/telemetry --device-id stop-01
```

Replace the example port with the Uno's port shown in Arduino IDE (**Tools > Port**); macOS ports commonly begin `/dev/cu.usbmodem`, Windows ports look like `COM3`, and Linux ports commonly look like `/dev/ttyACM0`. The bridge also accepts `SERIAL_PORT`, `TELEMETRY_URL`, and `DEVICE_ID` environment variables. Close Arduino IDE's Serial Monitor before running the bridge because only one process can use the serial port at a time. Stop it with Ctrl+C.

For a hosted API, pass its full telemetry endpoint using `--api-url`, for example `https://your-api.example/telemetry`. The API must be reachable from the computer running the bridge, and the frontend must point at that same backend to display its readings. This demo API has no authentication; do not expose it publicly without adding authentication and deployment safeguards. The bridge sends temperature and humidity; water level, power, and cooler state are stored as `null` and shown as not reported, rather than fabricated.

## Shared ESP32/FastAPI payload

The simulator and USB serial bridge send this schema to `POST /telemetry`. Firmware with network access (for example, an ESP32 program using Wi-Fi) can send the same JSON using HTTP POST with `Content-Type: application/json`; the shared SHT31 sketch in this project uses USB serial instead:

```json
{
  "device_id": "stop-01",
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

The API validates values and returns HTTP `201` for accepted data or `422` for invalid fields. `crowd_level` accepts `Low`, `Moderate`, `High`, or `Unknown`; `crowd_source` identifies `simulated`, `manual`, `sensor`, `operator`, or `unknown` data; omitted sources default to `unknown`. Read recent records at `GET /telemetry?limit=200`; filter by device with `GET /telemetry?device_id=stop-01`.

For real deployment, only report a stop crowd level from a verified source (for example manual observation or an approved people-counting sensor), with a timestamp and source label. GPS on buses does not provide occupancy. The local doorway counter below estimates onboard occupancy from observed crossings; it does not measure the waiting crowd and is not a substitute for a validated passenger-counting system.

### Local doorway passenger counter (boarding/alighting/occupancy)

The Operations view keeps the CoolStop dashboard and telemetry intact. Its browser webcam counter adapts CrowdCounter1’s TensorFlow.js COCO-SSD (`mobilenet_v2`) person detector, confidence filtering, lower-body point tracking, configurable horizontal/vertical counting line, direction selection, and crossing safeguards (multiple observations, minimum travel distance, and per-track cooldown). Person boxes and track IDs are drawn over the local preview. This browser path does not use YOLO. Camera video stays in the browser and only aggregate reports are posted to `POST /passenger-counts`. The browser counter requires a secure page (HTTPS or localhost) and camera permission. Choose a bus route in the controls; reports are associated with that route and appear in Operations. These doorway crossings estimate boarding/alighting and onboard occupancy; they do not measure the crowd waiting at the stop.

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
