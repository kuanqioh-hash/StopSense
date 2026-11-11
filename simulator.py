import json
import os
import random
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_URL = os.environ.get("TELEMETRY_URL", "http://127.0.0.1:8000/telemetry")
DEVICE_ID = os.environ.get("DEVICE_ID", "USJ7")
INTERVAL_SECONDS = max(1, int(os.environ.get("SEND_INTERVAL_SECONDS", "5")))


def post_reading(payload: dict[str, object]) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        API_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=5) as response:
        print(f"HTTP {response.status}: {response.read().decode('utf-8')}")


def main() -> None:
    temperature = 32.0
    humidity = 70.0
    water_level = 88.0
    crowd_level = "Moderate"
    print(f"Sending SIMULATED readings for {DEVICE_ID} to {API_URL}")
    print("Press Ctrl+C to stop.")

    while True:
        temperature = min(38.0, max(27.0, temperature + random.uniform(-0.5, 0.5)))
        humidity = min(90.0, max(45.0, humidity + random.uniform(-1.5, 1.5)))
        water_level = min(100.0, max(0.0, water_level - random.uniform(0.0, 0.12)))
        fault_code = None
        if random.random() < 0.04:
            fault_code = random.choice(["LOW_WATER", "SENSOR_CHECK"])
        if fault_code == "LOW_WATER":
            water_level = min(water_level, 12.0)
        if random.random() < 0.25:
            crowd_level = random.choices(
                ["Low", "Moderate", "High"], weights=[0.35, 0.45, 0.20], k=1
            )[0]

        cooler_on = humidity < 82.0 and water_level > 10.0 and fault_code is None
        payload = {
            "device_id": DEVICE_ID,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "temperature_c": round(temperature, 1),
            "humidity_pct": round(humidity, 1),
            "water_level_pct": round(water_level, 1),
            "power_w": round(random.uniform(8.0, 18.0) if cooler_on else 0.4, 1),
            "cooler_on": cooler_on,
            "crowd_level": crowd_level,
            "crowd_source": "simulated",
            "fault_code": fault_code,
        }

        try:
            post_reading(payload)
        except (HTTPError, URLError, TimeoutError) as error:
            print(f"Could not send reading: {error}")
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
