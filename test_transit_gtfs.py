import csv
import io
import zipfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

from fastapi import HTTPException

import main


class RapidKlGtfsTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(main.GTFS_TIMEZONE)
        self.service_date = self.now.date()
        weekday = self.service_date.strftime("%A").lower()
        self.calendar = {
            "service_id": "daily",
            **{day: "1" if day == weekday else "0" for day in (
                "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
            )},
            "start_date": (self.service_date - timedelta(days=1)).strftime("%Y%m%d"),
            "end_date": (self.service_date + timedelta(days=1)).strftime("%Y%m%d"),
        }
        self.zip_bytes = self._feed_zip()
        self.cache_patch = patch.object(main, "_gtfs_cache", {"expires_at": 0.0, "data": None})
        self.cache_patch.start()
        self.url_patch = patch.object(main, "GTFS_STATIC_URL", "https://feed.example/rapidkl.zip")
        self.url_patch.start()

    def tearDown(self):
        self.url_patch.stop()
        self.cache_patch.stop()

    def _gtfs_time(self, minutes_from_midnight):
        hours, minutes = divmod(minutes_from_midnight, 60)
        return f"{hours:02}:{minutes:02}:00"

    def _feed_zip(self):
        midnight = datetime.combine(self.service_date, datetime.min.time(), main.GTFS_TIMEZONE)
        soon_minutes = int((self.now + timedelta(minutes=25) - midnight).total_seconds() // 60)
        later_minutes = int((self.now + timedelta(minutes=55) - midnight).total_seconds() // 60)
        files = {
            "stops.txt": [
                {"stop_id": "1005834", "stop_name": "STESEN BRT USJ7", "stop_lat": "3.05", "stop_lon": "101.59"},
                {"stop_id": "1006526", "stop_name": "SJ693 LRT USJ 7", "stop_lat": "3.05", "stop_lon": "101.59"},
                {"stop_id": "1006524", "stop_name": "SJ63 LRT SUBANG JAYA", "stop_lat": "3.08", "stop_lon": "101.58"},
                {"stop_id": "1006550", "stop_name": "SJ705 LRT PUTRA HEIGHT", "stop_lat": "2.99", "stop_lon": "101.57"},
            ],
            "routes.txt": [
                {"route_id": "B1000", "route_short_name": "SUNWAY LINE", "route_long_name": "BRT USJ 7 - BRT Setia Jaya"},
                {"route_id": "U7700", "route_short_name": "770", "route_long_name": "Subang Mewah USJ 1 ~ Hab Pasar Seni"},
            ],
            "trips.txt": [
                {"route_id": "B1000", "service_id": "daily", "trip_id": "trip1", "trip_headsign": "SETIA JAYA", "shape_id": "shape1"},
                {"route_id": "U7700", "service_id": "daily", "trip_id": "trip2", "trip_headsign": "HAB PASAR SENI", "shape_id": "shape2"},
            ],
            "calendar.txt": [self.calendar],
            "stop_times.txt": [
                {"trip_id": "trip1", "stop_id": "1005834", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
                {"trip_id": "trip2", "stop_id": "1006526", "arrival_time": self._gtfs_time(later_minutes), "departure_time": self._gtfs_time(later_minutes)},
                {"trip_id": "trip1", "stop_id": "1006524", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
            ],
            "shapes.txt": [
                {"shape_id": "shape2", "shape_pt_lat": "3.04", "shape_pt_lon": "101.59", "shape_pt_sequence": "1"},
                {"shape_id": "shape2", "shape_pt_lat": "3.05", "shape_pt_lon": "101.59", "shape_pt_sequence": "2"},
                {"shape_id": "shape2", "shape_pt_lat": "3.06", "shape_pt_lon": "101.59", "shape_pt_sequence": "3"},
            ],
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for filename, rows in files.items():
                text = io.StringIO()
                writer = csv.DictWriter(text, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows(rows)
                archive.writestr(filename, text.getvalue())
        return output.getvalue()

    def test_static_feed_is_cached_and_stations_use_official_stop_metadata(self):
        response = Mock(content=self.zip_bytes)
        response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", return_value=response) as get:
            stops = main.transit_stops()
            second = main.transit_stops()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(stops["source"], "RapidKL GTFS Static")
        self.assertEqual([station["id"] for station in stops["stations"]], ["usj7", "subang-jaya", "putra-heights"])
        self.assertEqual(stops["stations"][0]["stop_ids"], ["1006526"])
        self.assertEqual(stops["stations"][0]["stops"][0]["stop_name"], "SJ693 LRT USJ 7")
        self.assertEqual(second["fetched_at"], stops["fetched_at"])

    def test_scheduled_departures_remain_for_other_stations(self):
        response = Mock(content=self.zip_bytes)
        response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", return_value=response):
            result = main.transit_departures("subang-jaya")
        self.assertFalse(result["realtime"])
        self.assertEqual(result["source"], "RapidKL GTFS Static")
        self.assertEqual(len(result["departures"]), 1)
        self.assertEqual(result["departures"][0]["route"], "SUNWAY LINE")
        self.assertTrue(result["departures"][0]["minutes_until"] > 0)

    def _vehicle_feed(self, *, latitude=3.04, timestamp=None):
        message = main.gtfs_realtime_pb2.FeedMessage()
        message.header.gtfs_realtime_version = "2.0"
        message.header.timestamp = int((timestamp or datetime.now(main.GTFS_TIMEZONE)).timestamp())
        entity = message.entity.add()
        entity.id = "vehicle-1"
        entity.vehicle.trip.trip_id = "trip2"
        entity.vehicle.trip.route_id = "U7700"
        entity.vehicle.vehicle.id = "vehicle-1"
        entity.vehicle.position.latitude = latitude
        entity.vehicle.position.longitude = 101.59
        entity.vehicle.position.bearing = 0
        entity.vehicle.position.speed = 5
        entity.vehicle.timestamp = message.header.timestamp
        return message.SerializeToString()

    def test_usj7_uses_fresh_live_vehicle_and_only_sj693(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed())
        live_response.raise_for_status.return_value = None
        cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("usj7")
        self.assertTrue(result["realtime"])
        self.assertTrue(result["estimate"])
        self.assertEqual(result["stop_ids"], ["1006526"])
        self.assertEqual(len(result["departures"]), 1)
        self.assertEqual(result["departures"][0]["route"], "770")
        self.assertIn("arrival_at", result["departures"][0])
        self.assertNotIn("scheduled_at", result["departures"][0])
        self.assertGreater(result["departures"][0]["minutes_until"], 0)

    def test_usj7_ignores_stale_vehicle_positions(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed(timestamp=datetime.now(main.GTFS_TIMEZONE) - timedelta(minutes=3)))
        live_response.raise_for_status.return_value = None
        cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("usj7")
        self.assertEqual(result["departures"], [])

    def test_usj7_does_not_substitute_schedule_when_no_live_vehicle_exists(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        empty_feed = main.gtfs_realtime_pb2.FeedMessage()
        empty_feed.header.gtfs_realtime_version = "2.0"
        live_response = Mock(content=empty_feed.SerializeToString())
        live_response.raise_for_status.return_value = None
        cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("usj7")
        self.assertEqual(result["departures"], [])

    def test_unknown_station_is_rejected(self):
        with self.assertRaises(HTTPException) as error:
            main.transit_departures("unknown")
        self.assertEqual(error.exception.status_code, 404)

    def test_calendar_date_exceptions_override_weekly_service(self):
        calendar = [{**self.calendar, "service_id": "weekly"}]
        calendar[0][self.service_date.strftime("%A").lower()] = "0"
        exceptions = [
            {"service_id": "added", "date": self.service_date.strftime("%Y%m%d"), "exception_type": "1"},
            {"service_id": "weekly", "date": self.service_date.strftime("%Y%m%d"), "exception_type": "2"},
        ]
        self.assertEqual(main._active_services(calendar, self.service_date, exceptions), {"added"})

    def test_gtfs_times_can_extend_past_midnight(self):
        value = main._parse_gtfs_time("25:10:00", self.service_date)
        self.assertEqual(value.date(), self.service_date + timedelta(days=1))
        self.assertEqual(value.hour, 1)
        self.assertEqual(value.minute, 10)


if __name__ == "__main__":
    unittest.main()
