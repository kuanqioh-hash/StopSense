import html
import os

import pandas as pd
import requests
import streamlit as st

from arrival_simulator import format_eta, simulated_arrivals

API_BASE_URL = os.environ.get("TELEMETRY_API", "http://127.0.0.1:8000")

st.set_page_config(page_title="CoolStop · Township Transit", page_icon="🚌", layout="wide")
st.title("CoolStop | Comfortable waits, clearer journeys")
st.error(
    "DEMO MODE"
)
st.caption(
    "One prototype, three views: passenger app, bus-stop display, and operator dashboard. "
    "Crowd level means people waiting at the stop, not passengers onboard."
)


def preview_readings() -> pd.DataFrame:
    now = pd.Timestamp.now(tz="UTC")
    samples = [
        ("USJ7", 31.2, 72.0, 82.0, 13.8, True, "Moderate", None),
        ("Putra Heights", 33.4, 78.0, 61.0, 15.1, True, "High", None),
        ("Subang Jaya", 30.1, 69.0, 94.0, 0.4, False, "Low", "STANDBY"),
    ]
    preview = pd.DataFrame(
        [
            {
                "id": index,
                "device_id": stop_id,
                "timestamp": now,
                "temperature_c": temperature,
                "humidity_pct": humidity,
                "water_level_pct": water,
                "power_w": power,
                "cooler_on": cooler_on,
                "crowd_level": crowd,
                "crowd_source": "simulated",
                "fault_code": fault,
            }
            for index, (stop_id, temperature, humidity, water, power, cooler_on, crowd, fault)
            in enumerate(samples, start=1)
        ]
    )
    preview["timestamp"] = pd.to_datetime(preview["timestamp"], utc=True)
    return preview


def fetch_readings() -> pd.DataFrame:
    try:
        response = requests.get(f"{API_BASE_URL}/telemetry?limit=500", timeout=3)
        response.raise_for_status()
        items = response.json()["items"]
    except (requests.RequestException, ValueError, KeyError) as error:
        st.warning(
            f"Telemetry API unavailable at {API_BASE_URL}; showing local preview data. "
            "Start FastAPI and simulator.py to see incoming readings."
        )
        st.caption(str(error))
        return preview_readings()

    if not items:
        st.info("No API readings yet; showing local preview data. Start simulator.py to populate telemetry.")
        return preview_readings()

    data = pd.DataFrame(items)
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True, errors="coerce")
    data = data.dropna(subset=["timestamp"]).sort_values("timestamp")
    return data


def latest_by_stop(data: pd.DataFrame) -> pd.DataFrame:
    return data.groupby("device_id", as_index=False).tail(1).sort_values("device_id")


def render_arrivals(stop_id: str, compact: bool = False) -> None:
    arrivals = simulated_arrivals(stop_id)
    if compact:
        for arrival in arrivals[:3]:
            st.write(
                f"**{arrival['route']} · {arrival['destination']}** — "
                f"{format_eta(int(arrival['eta_seconds']))}"
            )
        st.caption("Simulated arrival estimates · refresh every 5 seconds")
        return

    arrival_columns = st.columns(3)
    for column, arrival in zip(arrival_columns, arrivals[:3]):
        with column:
            st.metric(
                f"{arrival['route']} → {arrival['destination']}",
                format_eta(int(arrival["eta_seconds"])),
            )


@st.fragment(run_every="5s")
def render_views() -> None:
    data = fetch_readings()
    if data is None or data.empty:
        return

    latest = latest_by_stop(data)
    stop_ids = latest["device_id"].tolist()
    passenger_tab, stop_screen_tab, operations_tab = st.tabs(
        ["📱 Passenger app", "🚌 Bus-stop screen", "🛠️ Operations dashboard"]
    )

    with passenger_tab:
        st.subheader("Your stop at a glance")
        selected_stop = st.selectbox("Choose a bus stop", stop_ids, key="passenger_stop")
        reading = latest.loc[latest["device_id"] == selected_stop].iloc[-1]
        metrics = st.columns(3)
        metrics[0].metric("Temperature", f"{reading['temperature_c']:.1f} °C")
        metrics[1].metric("Humidity", f"{reading['humidity_pct']:.1f}%")
        metrics[2].metric("Waiting-area crowd", reading["crowd_level"])
        st.caption(
            f"Crowd source: {reading['crowd_source']} · "
            f"Sensor update: {reading['timestamp'].strftime('%H:%M:%S UTC')}"
        )
        st.markdown("#### Next buses")
        render_arrivals(selected_stop)

    with stop_screen_tab:
        st.subheader("At-stop information screen")
        screen_stop = st.selectbox("Select screen location", stop_ids, key="screen_stop")
        reading = latest.loc[latest["device_id"] == screen_stop].iloc[-1]
        escaped_stop = html.escape(str(screen_stop))
        top_arrival = simulated_arrivals(screen_stop)[0]
        st.markdown(
            f"""<div style="background:#102a43;color:white;padding:28px;border-radius:18px;">
            <div style="font-size:22px;opacity:.85;">NEXT BUS · {html.escape(str(top_arrival['route']))}</div>
            <div style="font-size:58px;font-weight:700;line-height:1.2;">
            {html.escape(format_eta(int(top_arrival['eta_seconds'])))}</div>
            <div style="font-size:26px;">{html.escape(str(top_arrival['destination']))}</div>
            <hr style="border-color:#829ab1;">
            <div style="font-size:22px;">{escaped_stop} · Waiting crowd:
            {html.escape(str(reading['crowd_level']))} ·
            {float(reading['temperature_c']):.1f} °C ·
            {float(reading['humidity_pct']):.0f}% humidity</div>
            </div>""",
            unsafe_allow_html=True,
        )
        st.caption(
            f"Simulated arrivals · stop sensor updated {reading['timestamp'].strftime('%H:%M:%S UTC')}"
        )

    with operations_tab:
        st.subheader("Stop operations and cooling performance")
        for start in range(0, len(latest), 3):
            columns = st.columns(3)
            for column, (_, reading) in zip(columns, latest.iloc[start : start + 3].iterrows()):
                fault = reading["fault_code"]
                state = "FAULT" if pd.notna(fault) and fault else (
                    "Cooling" if reading["cooler_on"] else "Standby"
                )
                with column:
                    st.markdown(f"#### {reading['device_id']}")
                    st.metric("Air temperature", f"{reading['temperature_c']:.1f} °C")
                    st.metric("Relative humidity", f"{reading['humidity_pct']:.1f}%")
                    st.metric("Waiting-area crowd", reading["crowd_level"])
                    st.metric("Water level", f"{reading['water_level_pct']:.1f}%")
                    st.metric("Power", f"{reading['power_w']:.1f} W")
                    st.write(f"**Cooler state:** {state}")
                    render_arrivals(str(reading["device_id"]), compact=True)
                    if pd.notna(fault) and fault:
                        st.warning(f"Simulated fault: {fault}")
                    st.caption(f"Last sensor update: {reading['timestamp'].strftime('%H:%M:%S UTC')}")

        selected_history_stop = st.selectbox("Review sensor history", stop_ids, key="history_stop")
        history = data[data["device_id"] == selected_history_stop].tail(120).set_index("timestamp")
        chart_col1, chart_col2 = st.columns(2)
        with chart_col1:
            st.markdown("**Temperature (°C)**")
            st.line_chart(history[["temperature_c"]], height=230)
        with chart_col2:
            st.markdown("**Humidity (%)**")
            st.line_chart(history[["humidity_pct"]], height=230)

        st.markdown("**Water and power**")
        st.line_chart(history[["water_level_pct", "power_w"]], height=220)

        shown = data.sort_values("timestamp", ascending=False).head(20).copy()
        shown["timestamp"] = shown["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S UTC")
        shown["cooler_on"] = shown["cooler_on"].map({True: "On", False: "Off"})
        st.dataframe(
            shown[
                [
                    "timestamp",
                    "device_id",
                    "temperature_c",
                    "humidity_pct",
                    "water_level_pct",
                    "power_w",
                    "cooler_on",
                    "crowd_level",
                    "crowd_source",
                    "fault_code",
                ]
            ],
            width="stretch",
            hide_index=True,
        )


render_views()
