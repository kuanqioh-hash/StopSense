import argparse
import json
import math
import os
import re
import ssl
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import certifi
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_API_URL = os.environ.get("TELEMETRY_URL", "http://127.0.0.1:8000/telemetry")
DEFAULT_DEVICE_ID = os.environ.get("DEVICE_ID", "arduino-sht31-01")
TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())
SOLAR_VOLTAGE_PATTERN = re.compile(r"Solar Panel Voltage:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*V", re.IGNORECASE)


def parse_reading(line: str, device_id: str = DEFAULT_DEVICE_ID) -> dict[str, object] | None:
    line = line.strip()
    solar_match = SOLAR_VOLTAGE_PATTERN.fullmatch(line)
    if solar_match:
        solar_voltage_v = float(solar_match.group(1))
        if not math.isfinite(solar_voltage_v) or solar_voltage_v < 0:
            raise ValueError("Solar panel voltage must be a finite non-negative value")
        if solar_voltage_v < 0.2:
            solar_status = "NO OUTPUT DETECTED"
        elif solar_voltage_v < 1.0:
            solar_status = "LOW OUTPUT"
        elif solar_voltage_v < 2.5:
            solar_status = "GENERATING ELECTRICITY"
        else:
            solar_status = "VOLTAGE NEAR RATED LEVEL"
        return {
            "device_id": device_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "solar_voltage_v": solar_voltage_v,
            "solar_status": solar_status,
        }
    if line.lower().startswith("solar panel voltage:"):
        raise ValueError("Malformed solar panel voltage serial line")

    fields = line.split(",")
    if not fields or fields[0] not in {"SHT31", "STOPSENSE"}:
        return None

    is_combined_reading = fields[0] == "STOPSENSE"
    if len(fields) == 3 and fields[1] == "ERROR":
        raise ValueError(f"Arduino sensor error: {fields[2]}")
    valid_field_counts = {4, 5} if is_combined_reading else {3}
    if len(fields) not in valid_field_counts:
        sensor_name = "StopSense" if is_combined_reading else "SHT31"
        raise ValueError(f"Malformed {sensor_name} serial line")

    try:
        temperature_c = float(fields[1])
        humidity_pct = float(fields[2])
    except ValueError as error:
        raise ValueError("Temperature and humidity values must be numeric") from error

    if not math.isfinite(temperature_c) or not -20 <= temperature_c <= 70:
        raise ValueError("Temperature is outside the API's accepted range (-20 to 70 °C)")
    if not math.isfinite(humidity_pct) or not 0 <= humidity_pct <= 100:
        raise ValueError("Humidity must be between 0 and 100 percent")

    crowd_level = "Unknown"
    water_level_pct = None
    if is_combined_reading:
        crowd_levels = {"LOW": "Low", "MODERATE": "Moderate", "HIGH": "High", "UNKNOWN": "Unknown"}
        try:
            crowd_level = crowd_levels[fields[3].strip().upper()]
        except KeyError as error:
            raise ValueError("Crowd level must be Low, Moderate, High, or Unknown") from error
        if len(fields) == 5:
            try:
                water_level_pct = float(fields[4])
            except ValueError as error:
                raise ValueError("Water level must be numeric") from error
            if not math.isfinite(water_level_pct) or not 0 <= water_level_pct <= 100:
                raise ValueError("Water level must be between 0 and 100 percent")

    return {
        "device_id": device_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "temperature_c": temperature_c,
        "humidity_pct": humidity_pct,
        "water_level_pct": water_level_pct,
        "power_w": None,
        "cooler_on": None,
        "crowd_level": crowd_level,
        "crowd_source": "sensor",
        "fault_code": None,
    }


def post_reading(api_url: str, payload: dict[str, object]) -> None:
    request_url = api_url
    if "solar_voltage_v" in payload and urlsplit(api_url).path.rstrip("/").endswith("/telemetry"):
        request_url = api_url.rstrip("/") + "/solar"
    request = Request(
        request_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=5, context=TLS_CONTEXT) as response:
        if "solar_voltage_v" in payload:
            print(f"Saved solar voltage {payload['solar_voltage_v']} V ({payload['solar_status']}): HTTP {response.status}")
        else:
            sensor_summary = f"Saved {payload['temperature_c']} °C, {payload['humidity_pct']}% RH"
            if payload.get("water_level_pct") is not None:
                sensor_summary += f", water level {payload['water_level_pct']}%"
            print(f"{sensor_summary}: HTTP {response.status}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Forward StopSense, water-level, and solar readings from an Arduino to the API")
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
