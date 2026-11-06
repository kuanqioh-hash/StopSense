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
                {"route_id": "B1000", "service_id": "daily", "trip_id": "trip1", "trip_headsign": "SETIA JAYA"},
                {"route_id": "U7700", "service_id": "daily", "trip_id": "trip2", "trip_headsign": "HAB PASAR SENI"},
            ],
            "calendar.txt": [self.calendar],
            "stop_times.txt": [
                {"trip_id": "trip1", "stop_id": "1005834", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
                {"trip_id": "trip2", "stop_id": "1006526", "arrival_time": self._gtfs_time(later_minutes), "departure_time": self._gtfs_time(later_minutes)},
                {"trip_id": "trip1", "stop_id": "1006524", "arrival_time": self._gtfs_time(soon_minutes), "departure_time": self._gtfs_time(soon_minutes)},
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
        self.assertEqual(stops["stations"][0]["stops"][0]["stop_name"], "STESEN BRT USJ7")
        self.assertEqual(second["fetched_at"], stops["fetched_at"])

    def test_departures_are_scheduled_and_scoped_to_selected_station(self):
        response = Mock(content=self.zip_bytes)
        response.raise_for_status.return_value = None
        with patch.object(main.requests, "get", return_value=response):
            result = main.transit_departures("usj7")
        self.assertFalse(result["realtime"])
        self.assertEqual(result["source"], "RapidKL GTFS Static")
        self.assertEqual(len(result["departures"]), 2)
        self.assertEqual([item["route"] for item in result["departures"]], ["SUNWAY LINE", "770"])
        self.assertTrue(all(item["minutes_until"] > 0 for item in result["departures"]))

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
