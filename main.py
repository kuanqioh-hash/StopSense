import asyncio
import csv
import io
import json
import os
import sqlite3
import threading
import time
import zipfile
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

import requests

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

DB_PATH = Path(os.environ.get("TELEMETRY_DB", "telemetry.db"))
GTFS_STATIC_URL = os.environ.get(
    "GTFS_STATIC_URL",
    "https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-kl",
)
GTFS_CACHE_SECONDS = 24 * 60 * 60
GTFS_TIMEZONE = ZoneInfo("Asia/Kuala_Lumpur")
GTFS_STATIONS = {
    "usj7": {
        "name": "USJ 7 (BRT & LRT)",
        "stops": ("1005834", "1006526"),
    },
    "subang-jaya": {
        "name": "LRT Subang Jaya",
        "stops": ("1006524",),
    },
    "putra-heights": {
        "name": "LRT Putra Heights",
        "stops": ("1006550",),
    },
}
_gtfs_cache: dict[str, object] = {"expires_at": 0.0, "data": None}
_gtfs_cache_lock = threading.Lock()

app = FastAPI(title="Bus Stop Telemetry Demo", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://qiphy.github.io",
        "https://localhost",
        "capacitor://localhost",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

telemetry_subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue[str]]] = set()
subscriber_lock = threading.Lock()


def publish_telemetry_update() -> None:
    with subscriber_lock:
        subscribers = tuple(telemetry_subscribers)

    for loop, queue in subscribers:
        def enqueue(target: asyncio.Queue[str] = queue) -> None:
            if target.full():
                try:
                    target.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            target.put_nowait("update")

        try:
            loop.call_soon_threadsafe(enqueue)
        except RuntimeError:
            with subscriber_lock:
                telemetry_subscribers.discard((loop, queue))


class Reading(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    timestamp: datetime
    temperature_c: float = Field(ge=-20, le=70)
    humidity_pct: float = Field(ge=0, le=100)
    water_level_pct: float | None = Field(default=None, ge=0, le=100)
    power_w: float | None = Field(default=None, ge=0, le=5000)
    cooler_on: bool | None = None
    crowd_level: Literal["Low", "Moderate", "High", "Unknown"] = "Unknown"
    crowd_source: Literal["simulated", "manual", "sensor", "operator", "unknown"] = "unknown"
    fault_code: str | None = Field(default=None, max_length=64)


class PassengerCount(BaseModel):
    camera_id: str = Field(min_length=1, max_length=64)
    bus_route: str | None = Field(default=None, min_length=1, max_length=32)
    observed_at: datetime
    boarding_count: int = Field(ge=0)
    alighting_count: int = Field(ge=0)
    occupancy_count: int | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0, le=1)
    status: Literal["ok", "degraded", "offline", "error"]


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_db() -> None:
    with closing(connect_db()) as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS telemetry (
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
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(telemetry)")
        }
        if "crowd_level" not in columns:
            connection.execute(
                "ALTER TABLE telemetry ADD COLUMN crowd_level TEXT NOT NULL DEFAULT 'Unknown'"
            )
        if "crowd_source" not in columns:
            connection.execute(
                "ALTER TABLE telemetry ADD COLUMN crowd_source TEXT NOT NULL DEFAULT 'unknown'"
            )

        column_nullability = {
            row["name"]: row["notnull"]
            for row in connection.execute("PRAGMA table_info(telemetry)")
        }
        optional_fields = ("water_level_pct", "power_w", "cooler_on")
        if any(column_nullability.get(field, 0) for field in optional_fields):
            connection.execute("DROP INDEX IF EXISTS idx_telemetry_device_time")
            connection.execute("ALTER TABLE telemetry RENAME TO telemetry_legacy")
            connection.execute(
                """CREATE TABLE telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    temperature_c REAL NOT NULL,
                    humidity_pct REAL NOT NULL,
                    water_level_pct REAL,
                    power_w REAL,
                    cooler_on INTEGER,
                    crowd_level TEXT NOT NULL DEFAULT 'Unknown',
                    crowd_source TEXT NOT NULL DEFAULT 'unknown',
                    fault_code TEXT
                )"""
            )
            connection.execute(
                """INSERT INTO telemetry (
                    id, device_id, timestamp, temperature_c, humidity_pct,
                    water_level_pct, power_w, cooler_on, crowd_level, crowd_source, fault_code
                ) SELECT
                    id, device_id, timestamp, temperature_c, humidity_pct,
                    water_level_pct, power_w, cooler_on, crowd_level, crowd_source, fault_code
                FROM telemetry_legacy"""
            )
            connection.execute("DROP TABLE telemetry_legacy")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_telemetry_device_time "
            "ON telemetry(device_id, timestamp DESC)"
        )
        passenger_count_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(passenger_counts)")
        }
        if passenger_count_columns and "occupancy_count" not in passenger_count_columns:
            connection.execute("ALTER TABLE passenger_counts ADD COLUMN occupancy_count INTEGER")
        if passenger_count_columns and "bus_route" not in passenger_count_columns:
            connection.execute("ALTER TABLE passenger_counts ADD COLUMN bus_route TEXT")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS passenger_counts (
                camera_id TEXT PRIMARY KEY,
                bus_route TEXT,
                observed_at TEXT NOT NULL,
                boarding_count INTEGER NOT NULL CHECK (boarding_count >= 0),
                alighting_count INTEGER NOT NULL CHECK (alighting_count >= 0),
                occupancy_count INTEGER CHECK (occupancy_count >= 0),
                confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
                status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'offline', 'error'))
            )"""
        )
        connection.commit()


initialize_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "bus-stop-telemetry-demo"}


def _parse_gtfs_time(value: str, service_date: date) -> datetime:
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    return datetime.combine(service_date, datetime.min.time(), GTFS_TIMEZONE) + timedelta(
        hours=hours, minutes=minutes, seconds=seconds
    )


def _active_services(
    calendar_rows: list[dict[str, str]],
    service_date: date,
    calendar_date_rows: list[dict[str, str]] | None = None,
) -> set[str]:
    weekday = service_date.strftime("%A").lower()
    service_key = service_date.strftime("%Y%m%d")
    active = {
        row["service_id"]
        for row in calendar_rows
        if row.get(weekday) == "1"
        and row.get("start_date", "") <= service_key <= row.get("end_date", "")
    }
    for row in calendar_date_rows or []:
        if row.get("date") != service_key:
            continue
        if row.get("exception_type") == "1":
            active.add(row["service_id"])
        elif row.get("exception_type") == "2":
            active.discard(row["service_id"])
    return active


def _download_gtfs() -> dict[str, object]:
    with _gtfs_cache_lock:
        cached = _gtfs_cache["data"]
        if cached is not None and float(_gtfs_cache["expires_at"]) > time.monotonic():
            return cached  # type: ignore[return-value]

        try:
            response = requests.get(GTFS_STATIC_URL, timeout=30)
            response.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                def read_csv(filename: str) -> list[dict[str, str]]:
                    with archive.open(filename) as file:
                        return list(csv.DictReader(io.TextIOWrapper(file, encoding="utf-8-sig")))

                stops = {row["stop_id"]: row for row in read_csv("stops.txt")}
                routes = {row["route_id"]: row for row in read_csv("routes.txt")}
                trips = {row["trip_id"]: row for row in read_csv("trips.txt")}
                archive_files = set(archive.namelist())
                calendar_rows = read_csv("calendar.txt") if "calendar.txt" in archive_files else []
                calendar_date_rows = (
                    read_csv("calendar_dates.txt")
                    if "calendar_dates.txt" in archive_files
                    else []
                )
                stop_ids = {
                    stop_id for station in GTFS_STATIONS.values() for stop_id in station["stops"]
                }
                departures = []
                for row in read_csv("stop_times.txt"):
                    if row["stop_id"] not in stop_ids:
                        continue
                    trip = trips.get(row["trip_id"])
                    route = routes.get(trip["route_id"]) if trip else None
                    if trip is None or route is None:
                        continue
                    departures.append({
                        "stop_id": row["stop_id"],
                        "stop_name": stops.get(row["stop_id"], {}).get("stop_name", ""),
                        "route": route.get("route_short_name", ""),
                        "destination": trip.get("trip_headsign") or route.get("route_long_name", ""),
                        "service_id": trip["service_id"],
                        "departure_time": row.get("departure_time") or row["arrival_time"],
                    })
                feed: dict[str, object] = {
                    "stations": [
                        {
                            "id": station_id,
                            "name": station["name"],
                            "stop_ids": list(station["stops"]),
                            "stops": [stops[stop_id] for stop_id in station["stops"] if stop_id in stops],
                        }
                        for station_id, station in GTFS_STATIONS.items()
                    ],
                    "calendar": calendar_rows,
                    "calendar_dates": calendar_date_rows,
                    "departures": departures,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }
        except (requests.RequestException, zipfile.BadZipFile, KeyError, csv.Error) as exc:
            raise HTTPException(status_code=503, detail="RapidKL GTFS schedule is temporarily unavailable") from exc

        _gtfs_cache["data"] = feed
        _gtfs_cache["expires_at"] = time.monotonic() + GTFS_CACHE_SECONDS
        return feed


@app.get("/transit/stops")
def transit_stops() -> dict[str, object]:
    feed = _download_gtfs()
    return {"stations": feed["stations"], "source": "RapidKL GTFS Static", "fetched_at": feed["fetched_at"]}


@app.get("/transit/departures")
def transit_departures(station_id: str = Query(min_length=1, max_length=32)) -> dict[str, object]:
    if station_id not in GTFS_STATIONS:
        raise HTTPException(status_code=404, detail="Unknown RapidKL station")

    feed = _download_gtfs()
    now = datetime.now(GTFS_TIMEZONE)
    calendar_rows = feed["calendar"]
    calendar_date_rows = feed["calendar_dates"]
    departures = feed["departures"]
    station_stop_ids = set(GTFS_STATIONS[station_id]["stops"])
    results = []
    for service_date in (
        now.date() - timedelta(days=1),
        now.date(),
        now.date() + timedelta(days=1),
    ):
        active = _active_services(calendar_rows, service_date, calendar_date_rows)
        for item in departures:
            if item["stop_id"] not in station_stop_ids or item["service_id"] not in active:
                continue
            scheduled = _parse_gtfs_time(item["departure_time"], service_date)
            if scheduled >= now:
                results.append({
                    "route": item["route"],
                    "destination": item["destination"],
                    "stop_name": item["stop_name"],
                    "scheduled_at": scheduled.isoformat(),
                    "scheduled_time": scheduled.strftime("%H:%M"),
                    "minutes_until": max(0, int((scheduled - now).total_seconds() / 60 + 0.999)),
                })
    results.sort(key=lambda item: item["scheduled_at"])
    station = next(item for item in feed["stations"] if item["id"] == station_id)
    return {
        "station": station,
        "stop_ids": station["stop_ids"],
        "departures": results[:6],
        "source": "RapidKL GTFS Static",
        "realtime": False,
        "fetched_at": feed["fetched_at"],
        "checked_at": now.isoformat(),
    }


@app.post("/telemetry", status_code=201)
def receive_telemetry(reading: Reading) -> dict[str, object]:
    timestamp = reading.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    payload = reading.model_dump()
    payload["timestamp"] = timestamp.astimezone(timezone.utc).isoformat()

    with closing(connect_db()) as connection:
        cursor = connection.execute(
            """INSERT INTO telemetry (
                device_id, timestamp, temperature_c, humidity_pct,
                water_level_pct, power_w, cooler_on, crowd_level, crowd_source, fault_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                payload["device_id"],
                payload["timestamp"],
                payload["temperature_c"],
                payload["humidity_pct"],
                payload["water_level_pct"],
                payload["power_w"],
                None if payload["cooler_on"] is None else int(payload["cooler_on"]),
                payload["crowd_level"],
                payload["crowd_source"],
                payload["fault_code"],
            ),
        )
        connection.commit()
        reading_id = cursor.lastrowid

    publish_telemetry_update()
    return {"ok": True, "id": reading_id, "device_id": payload["device_id"]}


@app.get("/telemetry")
def list_telemetry(
    limit: int = Query(default=200, ge=1, le=2000),
    device_id: str | None = Query(default=None, max_length=64),
) -> dict[str, list[dict[str, object]]]:
    sql = """SELECT id, device_id, timestamp, temperature_c, humidity_pct,
                     water_level_pct, power_w, cooler_on, crowd_level, crowd_source,
                     fault_code
              FROM telemetry"""
    params: list[object] = []
    if device_id:
        sql += " WHERE device_id = ?"
        params.append(device_id)
    sql += " ORDER BY timestamp DESC, id DESC LIMIT ?"
    params.append(limit)

    with closing(connect_db()) as connection:
        rows = connection.execute(sql, params).fetchall()
    items = [dict(row) for row in rows]
    for item in items:
        if item["cooler_on"] is not None:
            item["cooler_on"] = bool(item["cooler_on"])
    return {"items": items}


@app.get("/events/telemetry")
async def stream_telemetry(request: Request) -> StreamingResponse:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
    subscriber = (loop, queue)
    with subscriber_lock:
        telemetry_subscribers.add(subscriber)
    queue.put_nowait("initial")

    async def events():
        try:
            while not await request.is_disconnected():
                try:
                    await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue

                snapshot = {
                    "items": list_telemetry(limit=500, device_id=None)["items"],
                    "passenger_counts": list_passenger_counts(camera_id=None)["items"],
                }
                yield f"event: telemetry\ndata: {json.dumps(snapshot)}\n\n"
        finally:
            with subscriber_lock:
                telemetry_subscribers.discard(subscriber)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/passenger-counts", status_code=201)
def receive_passenger_count(count: PassengerCount) -> dict[str, object]:
    observed_at = count.observed_at
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=timezone.utc)
    payload = count.model_dump()
    payload["observed_at"] = observed_at.astimezone(timezone.utc).isoformat()

    with closing(connect_db()) as connection:
        connection.execute(
            """INSERT INTO passenger_counts (
                   camera_id, bus_route, observed_at, boarding_count, alighting_count,
                   occupancy_count, confidence, status
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(camera_id) DO UPDATE SET
                   bus_route = COALESCE(excluded.bus_route, passenger_counts.bus_route),
                   observed_at = excluded.observed_at,
                   boarding_count = excluded.boarding_count,
                   alighting_count = excluded.alighting_count,
                   occupancy_count = COALESCE(excluded.occupancy_count, passenger_counts.occupancy_count),
                   confidence = excluded.confidence,
                   status = excluded.status""",
            (
                payload["camera_id"],
                payload["bus_route"],
                payload["observed_at"],
                payload["boarding_count"],
                payload["alighting_count"],
                payload["occupancy_count"],
                payload["confidence"],
                payload["status"],
            ),
        )
        connection.commit()
    publish_telemetry_update()
    return {"ok": True, "camera_id": payload["camera_id"]}


@app.get("/passenger-counts")
def list_passenger_counts(
    camera_id: str | None = Query(default=None, max_length=64),
) -> dict[str, list[dict[str, object]]]:
    sql = """SELECT camera_id, bus_route, observed_at, boarding_count, alighting_count,
                    occupancy_count, confidence, status
             FROM passenger_counts"""
    params: list[object] = []
    if camera_id:
        sql += " WHERE camera_id = ?"
        params.append(camera_id)
    sql += " ORDER BY camera_id"
    with closing(connect_db()) as connection:
        rows = connection.execute(sql, params).fetchall()
    return {"items": [dict(row) for row in rows]}
