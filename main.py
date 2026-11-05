import asyncio
import json
import os
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

DB_PATH = Path(os.environ.get("TELEMETRY_DB", "telemetry.db"))

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
