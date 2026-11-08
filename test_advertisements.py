import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

import main
from ad_engine import rank_advertisements, time_slot_for_hour


class AdvertisementTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(main, "DB_PATH", Path(self.temp_dir.name) / "ads.db")
        self.db_patch.start()
        main.initialize_db()

    def tearDown(self):
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def test_targeting_filters_and_ranks_by_context(self):
        ads = [
            {"id": 1, "title": "general", "active": True},
            {"id": 2, "title": "match", "active": True, "stop_ids": ["stop-1"],
             "facility_tags": ["cafe"], "routes": ["752"], "crowd_levels": ["High"],
             "time_slots": ["lunch"], "min_temperature_c": 30, "busy_only": True},
            {"id": 3, "title": "wrong route", "active": True, "routes": ["T1"]},
        ]
        ranked = rank_advertisements(ads, stop_id="stop-1", facilities=["Cafe"], route="752",
                                     crowd_level="High", temperature_c=32, hour=12, traffic_score=0.9)
        self.assertEqual([ad["title"] for ad in ranked], ["match", "general"])
        self.assertEqual(ranked[0]["relevance_score"], 43)
        self.assertEqual(time_slot_for_hour(7), "breakfast")
        self.assertEqual(time_slot_for_hour(20), "evening")

    def test_advertisement_crud_and_recommendation_with_profile_facilities(self):
        ad = main.Advertisement(advertiser="Local Cafe", title="Warm lunch", detail="A nearby lunch offer.",
                                stop_ids=["stop-1"], facility_tags=["cafe"], crowd_levels=["High"], time_slots=["all-day"])
        created = main.create_advertisement(ad)
        main.save_stop_ad_profile("stop-1", main.StopAdProfile(stop_id="stop-1", radius_m=650, facilities=["cafe", "rail"]))
        response = main.advertisement_recommendations(stop_id="stop-1", route="752", crowd_level="High", temperature_c=32)
        self.assertEqual(response["context"]["radius_m"], 650)
        self.assertIn("cafe", response["context"]["facilities"])
        self.assertTrue(any(item["id"] == created["id"] for item in response["items"]))
        updated = main.update_advertisement(created["id"], main.Advertisement(advertiser="Local Cafe", title="Paused", detail="Updated campaign.", active=False))
        self.assertFalse(updated["active"])
        self.assertEqual(len(main.list_advertisements()["items"]), 4)
        main.delete_advertisement(created["id"])
        self.assertEqual(len(main.list_advertisements()["items"]), 3)

    def test_camera_count_deltas_accumulate_by_route_and_local_hour(self):
        report = main.PassengerCount(camera_id="cam-1", bus_route="752", observed_at="2026-10-21T00:00:00+00:00",
                                    boarding_count=3, alighting_count=1, confidence=0.9, status="ok")
        main.receive_passenger_count(report)
        report.boarding_count = 5
        report.alighting_count = 2
        main.receive_passenger_count(report)
        with closing(main.connect_db()) as connection:
            total = connection.execute("SELECT SUM(passenger_events) FROM traffic_by_route_hour WHERE route='752'").fetchone()[0]
        self.assertEqual(total, 7)

    def test_inquiry_submission_and_status_management(self):
        result = main.create_advertisement_inquiry(main.AdvertisementInquiry(
            name="Sam", email="sam@example.com", organization="Cafe", message="Please share placement options."))
        inquiries = main.list_advertisement_inquiries()["items"]
        self.assertEqual(inquiries[0]["id"], result["id"])
        self.assertEqual(inquiries[0]["status"], "new")
        updated = main.update_advertisement_inquiry(result["id"], main.InquiryStatus(status="contacted"))
        self.assertEqual(updated["status"], "contacted")

    def test_invalid_campaign_temperature_and_incomplete_coordinates_are_rejected(self):
        with self.assertRaises(ValidationError):
            main.Advertisement(advertiser="A", title="B", detail="C", min_temperature_c=35, max_temperature_c=20)
        with self.assertRaises(ValidationError):
            main.StopAdProfile(stop_id="stop-1", latitude=3.0)


if __name__ == "__main__":
    unittest.main()
