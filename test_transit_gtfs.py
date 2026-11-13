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
        self.realtime_cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        self.realtime_cache_patch.start()
        self.last_known_patch = patch.dict(main._gtfs_realtime_last_known, {}, clear=True)
        self.last_known_patch.start()
        self.url_patch = patch.object(main, "GTFS_STATIC_URL", "https://feed.example/rapidkl.zip")
        self.url_patch.start()

    def tearDown(self):
        self.url_patch.stop()
        self.last_known_patch.stop()
        self.realtime_cache_patch.stop()
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
                {"route_id": "U7700", "service_id": "daily", "trip_id": "trip3", "trip_headsign": "HAB PASAR SENI", "shape_id": "shape3"},
            ],
            "calendar.txt": [self.calendar],
            "stop_times.txt": [
                {"trip_id": "trip1", "stop_id": "1005834", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
                {"trip_id": "trip2", "stop_id": "1006526", "arrival_time": self._gtfs_time(later_minutes), "departure_time": self._gtfs_time(later_minutes)},
                {"trip_id": "trip1", "stop_id": "1006524", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
                {"trip_id": "trip2", "stop_id": "1006524", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
                {"trip_id": "trip3", "stop_id": "1006550", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
            ],
            "shapes.txt": [
                {"shape_id": "shape2", "shape_pt_lat": "3.04", "shape_pt_lon": "101.59", "shape_pt_sequence": "1"},
                {"shape_id": "shape2", "shape_pt_lat": "3.05", "shape_pt_lon": "101.59", "shape_pt_sequence": "2"},
                {"shape_id": "shape2", "shape_pt_lat": "3.06", "shape_pt_lon": "101.59", "shape_pt_sequence": "3"},
                {"shape_id": "shape2", "shape_pt_lat": "3.08", "shape_pt_lon": "101.58", "shape_pt_sequence": "4"},
                {"shape_id": "shape3", "shape_pt_lat": "3.00", "shape_pt_lon": "101.57", "shape_pt_sequence": "1"},
                {"shape_id": "shape3", "shape_pt_lat": "2.99", "shape_pt_lon": "101.57", "shape_pt_sequence": "2"},
                {"shape_id": "shape3", "shape_pt_lat": "2.98", "shape_pt_lon": "101.57", "shape_pt_sequence": "3"},
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

    def test_other_station_departures_use_live_estimates(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed())
        live_response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("subang-jaya")
        self.assertTrue(result["realtime"])
        self.assertTrue(result["estimate"])
        self.assertEqual(result["source"], "RapidKL GTFS-Realtime vehicle positions (estimated)")
        self.assertEqual(len(result["departures"]), 1)
        self.assertEqual(result["departures"][0]["route"], "770")
        self.assertTrue(result["departures"][0]["minutes_until"] > 0)
        self.assertEqual(len(result["timetable"]), 2)
        self.assertTrue(all("scheduled_at" in departure for departure in result["timetable"]))

    def test_lrt_stations_use_live_vehicle_positions(self):
        for station_id, trip_id, latitude, bearing in (
            ("subang-jaya", "trip2", 3.04, 0),
            ("putra-heights", "trip3", 3.00, 180),
        ):
            with self.subTest(station_id=station_id):
                main._gtfs_realtime_last_known.clear()
                main._gtfs_cache.update({"expires_at": 0.0, "data": None})
                main._gtfs_realtime_cache.update({"expires_at": 0.0, "data": None})
                static_response = Mock(content=self.zip_bytes)
                static_response.raise_for_status.return_value = None
                live_response = Mock(content=self._vehicle_feed(
                    latitude=latitude,
                    longitude=101.57 if trip_id == "trip3" else 101.59,
                    trip_id=trip_id,
                    bearing=bearing,
                ))
                live_response.raise_for_status.return_value = None
                with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
                    result = main.transit_departures(station_id)
                self.assertTrue(result["realtime"])
                self.assertTrue(result["estimate"])
                self.assertEqual(len(result["departures"]), 1)
                self.assertFalse(result["departures"][0]["stale_position"])
                self.assertIn("arrival_at", result["departures"][0])
                self.assertNotIn("scheduled_at", result["departures"][0])

    def test_live_estimate_does_not_depend_on_scheduled_service_calendar(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed())
        live_response.raise_for_status.return_value = None
        with patch.object(main, "_active_services", return_value=set()):
            with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
                result = main.transit_departures("subang-jaya")
        self.assertEqual(len(result["departures"]), 1)
        self.assertIn("arrival_at", result["departures"][0])

    def test_unrealistic_live_speed_uses_fallback_for_eta(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed(speed=28.1))
        live_response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("subang-jaya")
        self.assertEqual(len(result["departures"]), 1)
        self.assertGreater(result["departures"][0]["minutes_until"], 0)

    def test_last_known_vehicle_location_is_used_when_live_feed_fails(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed(timestamp=datetime.now(main.GTFS_TIMEZONE) - timedelta(minutes=5)))
        live_response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            main.transit_departures("subang-jaya")

        main._gtfs_realtime_cache.update({"expires_at": 0.0, "data": None})
        with patch.object(main.requests, "get", side_effect=main.requests.RequestException("feed unavailable")):
            result = main.transit_departures("subang-jaya")
        self.assertEqual(len(result["departures"]), 1)
        self.assertTrue(result["departures"][0]["stale_position"])
        self.assertGreaterEqual(result["departures"][0]["position_age_seconds"], 5 * 60)

    def test_last_known_positions_older_than_ten_minutes_are_discarded(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        old_position = Mock(content=self._vehicle_feed(timestamp=datetime.now(main.GTFS_TIMEZONE) - timedelta(minutes=11)))
        old_position.raise_for_status.return_value = None
        with patch.object(main.requests, "get", side_effect=[static_response, old_position]):
            result = main.transit_departures("subang-jaya")
        self.assertFalse(result["realtime"])
        self.assertEqual(result["source"], "RapidKL GTFS Static schedule")
        self.assertEqual(len(result["departures"]), 2)

        main._gtfs_realtime_cache.update({"expires_at": 0.0, "data": None})
        with patch.object(main.requests, "get", side_effect=main.requests.RequestException("feed unavailable")):
            result = main.transit_departures("subang-jaya")
        self.assertFalse(result["realtime"])
        self.assertEqual(len(result["departures"]), 2)

    def _vehicle_feed(self, *, latitude=3.04, longitude=101.59, trip_id="trip2", bearing=0, speed=5, timestamp=None):
        message = main.gtfs_realtime_pb2.FeedMessage()
        message.header.gtfs_realtime_version = "2.0"
        message.header.timestamp = int((timestamp or datetime.now(main.GTFS_TIMEZONE)).timestamp())
        entity = message.entity.add()
        entity.id = "vehicle-1"
        entity.vehicle.trip.trip_id = trip_id
        entity.vehicle.trip.route_id = "U7700"
        entity.vehicle.vehicle.id = f"vehicle-{trip_id}"
        entity.vehicle.position.latitude = latitude
        entity.vehicle.position.longitude = longitude
        entity.vehicle.position.bearing = bearing
        entity.vehicle.position.speed = speed
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

    def test_usj7_labels_last_known_vehicle_positions_as_stale(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        live_response = Mock(content=self._vehicle_feed(timestamp=datetime.now(main.GTFS_TIMEZONE) - timedelta(minutes=3)))
        live_response.raise_for_status.return_value = None
        cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        with patch.object(main.requests, "get", side_effect=[static_response, live_response]):
            result = main.transit_departures("usj7")
        self.assertEqual(len(result["departures"]), 1)
        self.assertTrue(result["departures"][0]["stale_position"])

    def test_usj7_falls_back_to_upcoming_static_schedule_without_live_vehicle(self):
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
        self.assertFalse(result["realtime"])
        self.assertFalse(result["estimate"])
        self.assertEqual(result["source"], "RapidKL GTFS Static schedule")
        self.assertEqual(len(result["departures"]), 1)
        self.assertEqual(result["departures"][0]["route"], "770")
        self.assertIn("scheduled_at", result["departures"][0])
        self.assertNotIn("arrival_at", result["departures"][0])

    def test_schedule_fallback_is_used_when_live_feed_is_unavailable(self):
        static_response = Mock(content=self.zip_bytes)
        static_response.raise_for_status.return_value = None
        cache_patch = patch.object(main, "_gtfs_realtime_cache", {"expires_at": 0.0, "data": None})
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        with patch.object(main.requests, "get", side_effect=[static_response, main.requests.RequestException("feed unavailable")]):
            result = main.transit_departures("usj7")
        self.assertFalse(result["realtime"])
        self.assertEqual(len(result["departures"]), 1)

    def test_full_day_timetable_keeps_past_trips_and_expands_frequency_windows(self):
        feed = {
            "departures": [
                {
                    "stop_id": "1006526", "service_id": "daily", "arrival_time": "06:00:00",
                    "departure_time": "06:00:00", "route": "770", "destination": "HAB PASAR SENI",
                    "stop_name": "SJ693", "sequence": 1, "trip_id": "scheduled-trip",
                },
                {
                    "stop_id": "1006526", "service_id": "daily", "arrival_time": "11:00:00",
                    "departure_time": "11:00:00", "route": "T776", "destination": "SUBANG MEWAH",
                    "stop_name": "SJ693", "sequence": 1, "trip_id": "frequency-trip",
                    "frequency_windows": [{
                        "start_time": "11:00:00", "end_time": "14:00:00", "headway_secs": 3600,
                        "exact_times": "0", "offset_seconds": 0,
                    }],
                },
            ],
            "calendar": [self.calendar],
            "calendar_dates": [],
        }
        now = datetime.combine(self.service_date, datetime.min.time(), main.GTFS_TIMEZONE) + timedelta(hours=12, minutes=15)

        timetable = main._scheduled_station_departures(
            feed, "usj7", now, include_past=True, same_calendar_day=True, limit=None
        )
        upcoming = main._scheduled_station_departures(feed, "usj7", now)

        self.assertEqual([item["scheduled_time"] for item in timetable], ["06:00", "11:00", "12:00", "13:00"])
        self.assertTrue(all(item["frequency_based"] is False for item in timetable[:1]))
        self.assertTrue(all(item["frequency_based"] is True for item in timetable[1:]))
        self.assertTrue(all(item["exact_times"] is False for item in timetable[1:]))
        self.assertEqual([item["scheduled_time"] for item in upcoming], ["13:00"])

    def test_schedule_fallback_respects_service_calendar_and_day_boundary(self):
        feed = {
            "departures": [
                {"stop_id": "1006526", "service_id": "daily", "arrival_time": "25:10:00", "departure_time": "25:10:00", "route": "770", "destination": "HAB PASAR SENI", "stop_name": "SJ693"},
            ],
            "calendar": [self.calendar],
            "calendar_dates": [],
        }
        now = datetime.combine(self.service_date + timedelta(days=1), datetime.min.time(), main.GTFS_TIMEZONE) + timedelta(minutes=20)
        departures = main._scheduled_station_departures(feed, "usj7", now)
        self.assertEqual(len(departures), 1)
        self.assertEqual(departures[0]["scheduled_at"], (now.replace(hour=1, minute=10)).isoformat())

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
