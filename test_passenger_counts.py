import asyncio
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

import main
from bus_counter import LineCrossingCounter, payload


class PassengerCountApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"
        self.db_patch = patch.object(main, "DB_PATH", self.db_path)
        self.db_patch.start()
        main.initialize_db()

    def tearDown(self):
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def test_latest_camera_counts_are_upserted_and_separate_from_waiting_crowd(self):
        report = {
            "camera_id": "bus-door-01",
            "bus_route": "T1",
            "observed_at": "2026-10-21T00:00:00+00:00",
            "boarding_count": 4,
            "alighting_count": 2,
            "occupancy_count": 7,
            "confidence": 0.84,
            "status": "ok",
        }
        main.receive_passenger_count(main.PassengerCount(**report))
        updated = {key: value for key, value in report.items() if key != "occupancy_count"}
        updated["boarding_count"] = 5
        main.receive_passenger_count(main.PassengerCount(**updated))
        listing = main.list_passenger_counts(camera_id="bus-door-01")["items"]
        self.assertEqual(len(listing), 1)
        self.assertEqual(listing[0]["boarding_count"], 5)
        self.assertEqual(listing[0]["alighting_count"], 2)
        self.assertEqual(listing[0]["occupancy_count"], 7)
        self.assertEqual(listing[0]["confidence"], 0.84)
        self.assertEqual(listing[0]["bus_route"], "T1")
        self.assertNotIn("crowd_level", listing[0])
        routes = [route for route in main.app.routes if route.path == "/passenger-counts"]
        self.assertEqual({method for route in routes for method in route.methods}, {"GET", "POST"})

    def test_vercel_api_prefix_routes_to_unprefixed_fastapi_endpoints(self):
        with patch.object(main.app, "root_path", "/api"):
            response = TestClient(main.app).get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_sse_stream_sends_initial_snapshot_and_pushes_new_telemetry(self):
        async def read_stream_events():
            request = type("RequestStub", (), {"is_disconnected": AsyncMock(return_value=False)})()
            response = await main.stream_telemetry(request)
            iterator = response.body_iterator
            initial_event = await anext(iterator)
            main.receive_telemetry(
                main.Reading(
                    device_id="streamed-stop",
                    timestamp=datetime.fromisoformat("2026-10-21T00:00:00+00:00"),
                    temperature_c=31.2,
                    humidity_pct=72,
                    water_level_pct=85,
                    power_w=14.6,
                    cooler_on=True,
                )
            )
            await asyncio.sleep(0)
            update_event = await anext(iterator)
            await iterator.aclose()
            return initial_event, update_event

        initial_event, update_event = asyncio.run(read_stream_events())
        self.assertTrue(initial_event.startswith("event: telemetry"))
        initial = json.loads(initial_event.split("data: ", 1)[1].strip())
        self.assertEqual(initial, {"items": [], "passenger_counts": []})
        updated = json.loads(update_event.split("data: ", 1)[1].strip())
        self.assertEqual(updated["items"][0]["device_id"], "streamed-stop")
        self.assertFalse(main.telemetry_subscribers)

    def test_existing_passenger_count_table_migrates_with_nullable_occupancy(self):
        with sqlite3.connect(self.db_path) as connection:
            connection.execute("DROP TABLE passenger_counts")
            connection.execute(
                """CREATE TABLE passenger_counts (
                    camera_id TEXT PRIMARY KEY,
                    observed_at TEXT NOT NULL,
                    boarding_count INTEGER NOT NULL,
                    alighting_count INTEGER NOT NULL,
                    confidence REAL NOT NULL,
                    status TEXT NOT NULL
                )"""
            )
        main.initialize_db()
        with sqlite3.connect(self.db_path) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(passenger_counts)")}
        self.assertIn("occupancy_count", columns)
        self.assertIn("bus_route", columns)

    def test_invalid_counts_and_confidence_are_rejected(self):
        with self.assertRaises(ValidationError):
            main.PassengerCount(
                camera_id="door",
                observed_at="2026-10-21T00:00:00+00:00",
                boarding_count=-1,
                alighting_count=0,
                confidence=1.5,
                status="ok",
            )

    def test_legacy_telemetry_payload_still_works_without_new_fields(self):
        reading = main.Reading(
            device_id="stop-legacy",
            timestamp=datetime.fromisoformat("2026-10-21T00:00:00+00:00"),
            temperature_c=31.2,
            humidity_pct=72,
            water_level_pct=85,
            power_w=14.6,
            cooler_on=True,
        )
        self.assertEqual(main.receive_telemetry(reading)["device_id"], "stop-legacy")
        stored = main.list_telemetry(limit=200, device_id="stop-legacy")["items"][0]
        self.assertEqual(stored["crowd_level"], "Unknown")
        self.assertEqual(stored["crowd_source"], "unknown")
        self.assertNotIn("boarding_count", stored)

    def test_sht31_only_telemetry_stores_unmeasured_fields_as_null(self):
        reading = main.Reading(
            device_id="arduino-sht31-01",
            timestamp=datetime.fromisoformat("2026-10-21T00:00:00+00:00"),
            temperature_c=25.4,
            humidity_pct=61.2,
            crowd_source="sensor",
        )
        main.receive_telemetry(reading)
        stored = main.list_telemetry(limit=200, device_id="arduino-sht31-01")["items"][0]
        self.assertEqual(stored["temperature_c"], 25.4)
        self.assertEqual(stored["humidity_pct"], 61.2)
        self.assertIsNone(stored["water_level_pct"])
        self.assertIsNone(stored["power_w"])
        self.assertIsNone(stored["cooler_on"])

    def test_telemetry_migration_preserves_existing_readings_and_index(self):
        with sqlite3.connect(self.db_path) as connection:
            connection.execute("DROP TABLE telemetry")
            connection.execute(
                """CREATE TABLE telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    temperature_c REAL NOT NULL,
                    humidity_pct REAL NOT NULL,
                    water_level_pct REAL NOT NULL,
                    power_w REAL NOT NULL,
                    cooler_on INTEGER NOT NULL,
                    crowd_level TEXT NOT NULL DEFAULT 'Unknown',
                    crowd_source TEXT NOT NULL DEFAULT 'unknown',
                    fault_code TEXT
                )"""
            )
            connection.execute(
                """INSERT INTO telemetry (
                    device_id, timestamp, temperature_c, humidity_pct,
                    water_level_pct, power_w, cooler_on, crowd_level, crowd_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("legacy-stop", "2026-10-21T00:00:00+00:00", 31.2, 72, 85, 14.6, 1, "Low", "manual"),
            )
        main.initialize_db()
        stored = main.list_telemetry(limit=200, device_id="legacy-stop")["items"][0]
        self.assertEqual(stored["temperature_c"], 31.2)
        self.assertEqual(stored["water_level_pct"], 85)
        self.assertEqual(stored["cooler_on"], True)
        with sqlite3.connect(self.db_path) as connection:
            indexes = {row[1] for row in connection.execute("PRAGMA index_list(telemetry)")}
        self.assertIn("idx_telemetry_device_time", indexes)


class LineCrossingTests(unittest.TestCase):
    def test_occupancy_increments_and_decrements_on_each_boundary_crossing(self):
        counter = LineCrossingCounter(0.5, "x", "right", hysteresis=5, initial_occupancy=3,
                                      min_displacement=0, min_track_frames=1, crossing_cooldown=0)
        counter.update(1, 30, 50, 100, 100)
        self.assertEqual(counter.update(1, 70, 50, 100, 100), "boarding")
        self.assertEqual(counter.occupancy_count, 4)
        self.assertEqual(counter.update(1, 30, 50, 100, 100), "alighting")
        self.assertEqual(counter.occupancy_count, 3)

    def test_occupancy_never_drops_below_zero(self):
        counter = LineCrossingCounter(0.5, "x", "right", hysteresis=5,
                                      min_displacement=0, min_track_frames=1, crossing_cooldown=0)
        counter.update(1, 70, 50, 100, 100)
        self.assertEqual(counter.update(1, 30, 50, 100, 100), "alighting")
        self.assertEqual(counter.occupancy_count, 0)

    def test_crossing_requires_minimum_observations_and_displacement(self):
        counter = LineCrossingCounter(0.5, "x", "right", hysteresis=5,
                                      min_displacement=30, min_track_frames=3, crossing_cooldown=0)
        self.assertIsNone(counter.update(1, 40, 50, 100, 100, now=0))
        self.assertIsNone(counter.update(1, 52, 50, 100, 100, now=0.1))
        self.assertIsNone(counter.update(1, 58, 50, 100, 100, now=0.2))
        self.assertIsNone(counter.update(1, 65, 50, 100, 100, now=0.3))
        self.assertEqual(counter.boardings, 0)
        self.assertEqual(counter.update(1, 75, 50, 100, 100, now=0.4), "boarding")
        self.assertEqual(counter.boardings, 1)

    def test_same_track_cannot_count_again_during_crossing_cooldown(self):
        counter = LineCrossingCounter(0.5, "x", "right", hysteresis=5,
                                      min_displacement=0, min_track_frames=1, crossing_cooldown=0.75)
        counter.update(1, 40, 50, 100, 100, now=0)
        self.assertEqual(counter.update(1, 60, 50, 100, 100, now=1), "boarding")
        self.assertIsNone(counter.update(1, 40, 50, 100, 100, now=1.1))
        self.assertEqual(counter.boardings, 1)
        self.assertEqual(counter.update(1, 40, 50, 100, 100, now=1.8), "alighting")

    def test_counts_line_crossings_and_emits_confidence_payload(self):
        counter = LineCrossingCounter(0.55, "y", "down", hysteresis=5,
                                      min_displacement=0, min_track_frames=1, crossing_cooldown=0)
        self.assertIsNone(counter.update(1, 50, 30, 100, 100, confidence=0.8))
        self.assertEqual(counter.update(1, 50, 70, 100, 100, confidence=0.9), "boarding")
        self.assertIsNone(counter.update(1, 50, 85, 100, 100, confidence=0.9))
        self.assertEqual(counter.update(2, 50, 80, 100, 100, confidence=0.85), None)
        self.assertEqual(counter.update(2, 50, 30, 100, 100, confidence=0.85), "alighting")
        self.assertEqual(counter.boardings, 1)
        self.assertEqual(counter.alightings, 1)
        result = payload(counter, "door-1", "ok", "T1")
        self.assertEqual(result["confidence"], 0.875)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["bus_route"], "T1")


if __name__ == "__main__":
    unittest.main()
