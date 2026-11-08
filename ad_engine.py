from __future__ import annotations

from datetime import datetime
from typing import Any

TIME_SLOTS = ("breakfast", "lunch", "commute", "evening", "all-day")
BUSY_TRAFFIC_THRESHOLD = 0.7


def time_slot_for_hour(hour: int) -> str:
    if 5 <= hour < 10:
        return "breakfast"
    if 11 <= hour < 14:
        return "lunch"
    if 15 <= hour < 19:
        return "commute"
    if 19 <= hour < 23:
        return "evening"
    return "all-day"


def rank_advertisements(
    advertisements: list[dict[str, Any]],
    *,
    stop_id: str,
    facilities: list[str],
    route: str | None,
    crowd_level: str,
    temperature_c: float | None,
    hour: int,
    traffic_score: float,
) -> list[dict[str, Any]]:
    """Return eligible ads sorted by how closely they match current aggregate context."""
    slot = time_slot_for_hour(hour)
    facility_set = {value.casefold() for value in facilities}
    ranked: list[dict[str, Any]] = []

    for ad in advertisements:
        if not ad.get("active", True):
            continue
        score = 0
        reasons: list[str] = []
        stop_ids = ad.get("stop_ids", [])
        if stop_ids:
            if stop_id not in stop_ids:
                continue
            score += 10
            reasons.append("selected stop")

        facility_targets = {value.casefold() for value in ad.get("facility_tags", [])}
        if facility_targets:
            matched_facilities = facility_set & facility_targets
            if not matched_facilities:
                continue
            score += 5
            reasons.append("nearby " + ", ".join(sorted(matched_facilities)))

        routes = ad.get("routes", [])
        if routes:
            if route not in routes:
                continue
            score += 8
            reasons.append(f"route {route}")

        crowd_levels = ad.get("crowd_levels", [])
        if crowd_levels:
            if crowd_level not in crowd_levels:
                continue
            score += 7
            reasons.append(f"{crowd_level.lower()} crowd")

        time_slots = ad.get("time_slots", [])
        if time_slots:
            if slot not in time_slots and "all-day" not in time_slots:
                continue
            score += 4
            reasons.append(slot)

        minimum = ad.get("min_temperature_c")
        maximum = ad.get("max_temperature_c")
        if minimum is not None or maximum is not None:
            if temperature_c is None:
                continue
            if minimum is not None and temperature_c < minimum:
                continue
            if maximum is not None and temperature_c > maximum:
                continue
            score += 3
            reasons.append(f"{temperature_c:.1f}°C at stop")

        if ad.get("busy_only"):
            if traffic_score < BUSY_TRAFFIC_THRESHOLD:
                continue
            score += 6
            reasons.append("historically busy period")

        ranked.append({**ad, "relevance_score": score, "match_reasons": reasons})

    ranked.sort(key=lambda ad: (-ad["relevance_score"], ad.get("id", 0)))
    return ranked


def parse_local_datetime(value: str, timezone: Any) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone)
    return parsed.astimezone(timezone)
