import argparse
import json
import math
import os
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_API_URL = os.environ.get("TELEMETRY_URL", "http://127.0.0.1:8000/telemetry")
DEFAULT_DEVICE_ID = os.environ.get("DEVICE_ID", "arduino-sht31-01")


def parse_reading(line: str, device_id: str = DEFAULT_DEVICE_ID) -> dict[str, object] | None:
    fields = line.strip().split(",")
    if not fields or fields[0] != "SHT31":
        return None
    if len(fields) == 3 and fields[1] == "ERROR":
        raise ValueError(f"Arduino sensor error: {fields[2]}")
    if len(fields) != 3:
        raise ValueError("Malformed SHT31 serial line")

    try:
        temperature_c = float(fields[1])
        humidity_pct = float(fields[2])
    except ValueError as error:
        raise ValueError("SHT31 values must be numeric") from error

    if not math.isfinite(temperature_c) or not -20 <= temperature_c <= 70:
        raise ValueError("Temperature is outside the API's accepted range (-20 to 70 °C)")
    if not math.isfinite(humidity_pct) or not 0 <= humidity_pct <= 100:
        raise ValueError("Humidity must be between 0 and 100 percent")

    return {
        "device_id": device_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "temperature_c": temperature_c,
        "humidity_pct": humidity_pct,
        "water_level_pct": None,
        "power_w": None,
        "cooler_on": None,
        "crowd_level": "Unknown",
        "crowd_source": "sensor",
        "fault_code": None,
    }


def post_reading(api_url: str, payload: dict[str, object]) -> None:
    request = Request(
        api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=5) as response:
        print(f"Saved {payload['temperature_c']} °C, {payload['humidity_pct']}% RH: HTTP {response.status}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Forward SHT31 readings from an Arduino Uno to the StopSense API")
    parser.add_argument("--port", default=os.environ.get("SERIAL_PORT"), help="USB serial port, e.g. /dev/cu.usbmodem1101 or COM3")
    parser.add_argument("--baud", type=int, default=115200, help="Serial baud rate (must match the Arduino sketch)")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="FastAPI telemetry endpoint")
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID, help="Unique stop identifier shown in the dashboard")
    args = parser.parse_args()
    if not args.port:
        parser.error("provide --port or set SERIAL_PORT")

    try:
        import serial
    except ImportError as error:
        raise SystemExit("pyserial is required; install it with: python -m pip install -r requirements-arduino.txt") from error

    print(f"Reading {args.device_id} from {args.port} and posting to {args.api_url}")
    print("Close the Arduino IDE Serial Monitor before starting this bridge. Press Ctrl+C to stop.")
    try:
        with serial.Serial(args.port, args.baud, timeout=1) as device:
            time.sleep(2)
            while True:
                line = device.readline().decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    payload = parse_reading(line, args.device_id)
                except ValueError as error:
                    print(error)
                    continue
                if payload is None:
                    continue
                try:
                    post_reading(args.api_url, payload)
                except HTTPError as error:
                    detail = error.read().decode("utf-8", errors="replace")
                    print(f"API rejected reading: HTTP {error.code}: {detail}")
                except (URLError, TimeoutError, OSError) as error:
                    print(f"Could not send reading: {error}")
    except KeyboardInterrupt:
        print("\nSerial bridge stopped.")
    except serial.SerialException as error:
        raise SystemExit(f"Could not open serial port {args.port}: {error}") from error


if __name__ == "__main__":
    main()
