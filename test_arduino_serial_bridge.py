import unittest
from unittest.mock import patch

import arduino_serial_bridge


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

    def test_ignores_non_sensor_serial_lines(self):
        self.assertIsNone(arduino_serial_bridge.parse_reading("Starting SHT31 sensor"))

    def test_rejects_sensor_errors_malformed_lines_and_out_of_range_values(self):
        for line in ("SHT31,ERROR,not_found", "SHT31,25.4", "SHT31,25.4,101"):
            with self.subTest(line=line), self.assertRaises(ValueError):
                arduino_serial_bridge.parse_reading(line)


if __name__ == "__main__":
    unittest.main()
