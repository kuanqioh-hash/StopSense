import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import arduino_serial_bridge
import main


class ArduinoSerialBridgeTests(unittest.TestCase):
    def test_parses_temperature_and_humidity_into_api_payload(self):
        with patch("arduino_serial_bridge.datetime") as mock_datetime:
            mock_datetime.now.return_value.isoformat.return_value = "2026-10-21T00:00:00+00:00"
            payload = arduino_serial_bridge.parse_reading("SHT31,25.40,61.20", "stop-sensor-1")

        self.assertEqual(payload["device_id"], "stop-sensor-1")
        self.assertEqual(payload["temperature_c"], 25.4)
        self.assertEqual(payload["humidity_pct"], 61.2)
        self.assertIsNone(payload["water_level_pct"])
        self.assertIsNone(payload["power_w"])
        self.assertIsNone(payload["cooler_on"])
        self.assertEqual(payload["crowd_source"], "sensor")

    def test_parses_combined_sensor_reading_and_maps_crowd_level(self):
        payload = arduino_serial_bridge.parse_reading("STOPSENSE,25.40,61.20,High", "stop-combined-1")

        self.assertEqual(payload["device_id"], "stop-combined-1")
        self.assertEqual(payload["temperature_c"], 25.4)
        self.assertEqual(payload["humidity_pct"], 61.2)
        self.assertEqual(payload["crowd_level"], "High")
        self.assertEqual(payload["crowd_source"], "sensor")

    def test_bridge_log_includes_presence_status(self):
        payload = arduino_serial_bridge.parse_reading("STOPSENSE,25.40,61.20,High", "stop-combined-1")
        with patch("builtins.print") as mock_print, patch("arduino_serial_bridge.urlopen") as mock_urlopen:
            mock_urlopen.return_value.__enter__.return_value.status = 201
            arduino_serial_bridge.post_reading("https://api.example/telemetry", payload)

        self.assertIn("presence detected (High)", mock_print.call_args.args[0])

    def test_parses_water_level_from_combined_sensor_record(self):
        for level in (0, 42.5, 100):
            with self.subTest(level=level):
                payload = arduino_serial_bridge.parse_reading(
                    f"STOPSENSE,25.4,61.2,High,{level}", "stop-combined-1"
                )
                self.assertEqual(payload["water_level_pct"], level)

    def test_maps_combined_crowd_categories_case_insensitively(self):
        expected = {
            "Low": "Low",
            "Moderate": "Moderate",
            "High": "High",
            "Unknown": "Unknown",
        }
        for input_level, api_level in expected.items():
            with self.subTest(level=input_level):
                payload = arduino_serial_bridge.parse_reading(f"STOPSENSE,25.4,61.2,{input_level.upper()}")
                self.assertEqual(payload["crowd_level"], api_level)

    def test_parses_solar_voltage_and_maps_panel_status(self):
        expected_statuses = {
            "Solar Panel Voltage: 0.10 V": "NO OUTPUT DETECTED",
            "Solar Panel Voltage: 0.50 V": "LOW OUTPUT",
            "Solar Panel Voltage: 1.50 V": "GENERATING ELECTRICITY",
            "Solar Panel Voltage: 3.25 V": "VOLTAGE NEAR RATED LEVEL",
        }
        for line, expected_status in expected_statuses.items():
            with self.subTest(line=line):
                payload = arduino_serial_bridge.parse_reading(line, "USJ7")
                self.assertEqual(payload["device_id"], "USJ7")
                self.assertEqual(payload["solar_status"], expected_status)
                self.assertIn("solar_voltage_v", payload)
                self.assertNotIn("temperature_c", payload)

    def test_ignores_non_sensor_serial_lines(self):
        self.assertIsNone(arduino_serial_bridge.parse_reading("Starting SHT31 sensor"))
        self.assertIsNone(arduino_serial_bridge.parse_reading("STATUS: LOW OUTPUT"))

    def test_rejects_invalid_solar_voltage(self):
        for line in ("Solar Panel Voltage: -1.00 V", "Solar Panel Voltage: nan V"):
            with self.subTest(line=line), self.assertRaises(ValueError):
                arduino_serial_bridge.parse_reading(line)

    def test_posts_solar_readings_to_the_solar_endpoint(self):
        payload = arduino_serial_bridge.parse_reading("Solar Panel Voltage: 3.25 V", "USJ7")
        with patch("arduino_serial_bridge.urlopen") as mock_urlopen:
            mock_urlopen.return_value.__enter__.return_value.status = 201
            arduino_serial_bridge.post_reading("https://api.example/telemetry", payload)

        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.example/telemetry/solar")

    def test_rejects_sensor_errors_malformed_lines_and_out_of_range_values(self):
        for line in (
            "SHT31,ERROR,not_found",
            "STOPSENSE,ERROR,sht31_not_found",
            "SHT31,25.4",
            "SHT31,25.4,101",
            "STOPSENSE,25.4,61.2",
            "STOPSENSE,25.4,61.2,Busy",
            "STOPSENSE,25.4,61.2,High,not-a-number",
            "STOPSENSE,25.4,61.2,High,nan",
            "STOPSENSE,25.4,61.2,High,100.1",
        ):
            with self.subTest(line=line), self.assertRaises(ValueError):
                arduino_serial_bridge.parse_reading(line)


class SolarTelemetryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(main, "DB_PATH", Path(self.temp_dir.name) / "solar-test.db")
        self.db_patch.start()
        main.initialize_db()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def test_stores_sensor_water_level_telemetry(self):
        payload = arduino_serial_bridge.parse_reading(
            "STOPSENSE,25.40,61.20,High,42.5", "USJ7"
        )
        response = self.client.post("/telemetry", json=payload)

        self.assertEqual(response.status_code, 201)
        items = self.client.get("/telemetry?device_id=USJ7").json()["items"]
        self.assertEqual(items[0]["water_level_pct"], 42.5)

    def test_stores_and_lists_solar_voltage_readings(self):
        response = self.client.post("/telemetry/solar", json={
            "device_id": "USJ7",
            "timestamp": "2026-11-13T12:00:00+00:00",
            "solar_voltage_v": 3.25,
            "solar_status": "VOLTAGE NEAR RATED LEVEL",
        })
        self.assertEqual(response.status_code, 201)
        items = self.client.get("/telemetry/solar?device_id=USJ7").json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["solar_voltage_v"], 3.25)
        self.assertEqual(items[0]["solar_status"], "VOLTAGE NEAR RATED LEVEL")

    def test_rejects_out_of_range_solar_reading(self):
        response = self.client.post("/telemetry/solar", json={
            "device_id": "USJ7",
            "timestamp": "2026-11-13T12:00:00+00:00",
            "solar_voltage_v": -1,
            "solar_status": "LOW OUTPUT",
        })
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
