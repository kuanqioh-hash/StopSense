import { useEffect, useMemo, useState } from 'react'
import LiveCameraCounter from './LiveCameraCounter'
import { EhailingCompare, getOfferLinkDetails } from './MobilityExtras'
import { AdvertisementOperations, TargetedAdvertisements } from './AdvertisementFeatures'

type CrowdLevel = 'Low' | 'Moderate' | 'High' | 'Unknown'
type Reading = {
  id: number
  device_id: string
  timestamp: string
  temperature_c: number
  humidity_pct: number
  water_level_pct: number | null
  power_w: number | null
  cooler_on: boolean | null
  crowd_level: CrowdLevel
  crowd_source: string
  fault_code: string | null
}
type PassengerCount = {
  camera_id: string
  bus_route?: string | null
  observed_at: string
  boarding_count: number
  alighting_count: number
  occupancy_count: number | null
  confidence: number
  status: 'ok' | 'degraded' | 'offline' | 'error'
}
type PassengerCountSession = {
  session_id: string
  camera_id: string
  bus_route?: string | null
  started_at: string
  ended_at?: string | null
  status: 'active' | 'completed' | 'interrupted' | 'error'
  latest_snapshot: {
    observed_at: string
    detected_now: number
    total_detected: number
    boarding_count: number
    alighting_count: number
    occupancy_count: number
  } | null
}
type View = 'passenger' | 'screen' | 'operations'
type Route = { route: string; destination: string }
type TransitStationOption = { id: string; name: string }
type TransitDeparture = { route: string; destination: string; stop_name: string; scheduled_at?: string; arrival_at?: string; scheduled_time: string; minutes_until: number; vehicle_id?: string; position_age_seconds?: number; stale_position?: boolean; frequency_based?: boolean; headway_minutes?: number | null; exact_times?: boolean }
type TimetableDeparture = TransitDeparture & { scheduled_at: string }
type TransitStation = { id: string; name: string; stop_ids: string[]; stops: { stop_id: string; stop_name: string; stop_lat: string; stop_lon: string }[] }
type SampleAccount = { id: string; name: string; initials: string; role: string; description: string; defaultView: View }

const API = import.meta.env.VITE_API_URL || '/api'
const DEMO_ACCOUNT_STORAGE_KEY = 'CoolStop-demo-account'
const sampleAccounts: SampleAccount[] = [
  { id: 'aisha-rahman', name: 'Aisha Rahman', initials: 'AR', role: 'Passenger', description: 'Check arrivals and waiting conditions.', defaultView: 'passenger' },
  { id: 'daniel-lim', name: 'Daniel Lim', initials: 'DL', role: 'Stop attendant', description: 'See the public bus-stop display.', defaultView: 'screen' },
  { id: 'mei-chen', name: 'Mei Chen', initials: 'MC', role: 'Operations manager', description: 'Monitor shelter and fleet operations.', defaultView: 'operations' },
]
const viewLabels: Record<View, string> = {
  passenger: 'Passenger app',
  screen: 'Bus-stop screen',
  operations: 'Operations',
}
const viewIcons: Record<View, string> = {
  passenger: '⌕',
  screen: '▣',
  operations: '⌘',
}
const rapidKlStations: TransitStationOption[] = [
  { id: 'usj7', name: 'USJ7' },
  { id: 'putra-heights', name: 'Putra Heights' },
  { id: 'subang-jaya', name: 'Subang Jaya' },
]

function getSavedSampleAccount(): SampleAccount | null {
  try {
    const savedId = localStorage.getItem(DEMO_ACCOUNT_STORAGE_KEY)
    return sampleAccounts.find((account) => account.id === savedId) ?? null
  } catch {
    return null
  }
}
const routes: Route[] = [
  { route: 'SUNWAY LINE', destination: 'BRT Setia Jaya' },
  { route: '641', destination: 'Pearl Point' },
  { route: '752', destination: 'Hentian Bandar Shah Alam' },
  { route: '770', destination: 'Hab Pasar Seni' },
  { route: 'T776', destination: 'Subang Mewah' },
]

const previewReadings: Reading[] = [
  { id: 1, device_id: 'USJ7', timestamp: new Date().toISOString(), temperature_c: 31.2, humidity_pct: 72, water_level_pct: 82, power_w: 13.8, cooler_on: true, crowd_level: 'Moderate', crowd_source: 'simulated', fault_code: null },
  { id: 2, device_id: 'Putra Heights', timestamp: new Date().toISOString(), temperature_c: 33.4, humidity_pct: 78, water_level_pct: 61, power_w: 15.1, cooler_on: true, crowd_level: 'High', crowd_source: 'simulated', fault_code: null },
  { id: 3, device_id: 'Subang Jaya', timestamp: new Date().toISOString(), temperature_c: 30.1, humidity_pct: 69, water_level_pct: 94, power_w: 0.4, cooler_on: false, crowd_level: 'Low', crowd_source: 'simulated', fault_code: 'STANDBY' },
]

function formatEta(seconds: number) {
  if (seconds < 60) return '<1min'
  return `${Math.ceil(seconds / 60)} min`
}

function transitTimestamp(departure: TransitDeparture) {
  return departure.arrival_at ?? departure.scheduled_at ?? ''
}

function lastPositionNote(departure: TransitDeparture) {
  if (!departure.stale_position) return ''
  const minutesOld = Math.max(1, Math.ceil((departure.position_age_seconds ?? 0) / 60))
  return `Last GPS position ${minutesOld} min old`
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'Timestamp unavailable' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function latestPerStop(readings: Reading[]) {
  const latest = new Map<string, Reading>()
  for (const reading of readings) {
    const previous = latest.get(reading.device_id)
    if (!previous || new Date(reading.timestamp).getTime() > new Date(previous.timestamp).getTime() || (reading.timestamp === previous.timestamp && reading.id > previous.id)) {
      latest.set(reading.device_id, reading)
    }
  }
  return [...latest.values()].sort((a, b) => a.device_id.localeCompare(b.device_id))
}

function normalizeStopName(stopId: string) {
  return stopId.toLowerCase().replace(/^lrt\s*/, '').replace(/[^a-z0-9]/g, '')
}

function App() {
  const [activeAccount, setActiveAccount] = useState<SampleAccount | null>(getSavedSampleAccount)
  const [readings, setReadings] = useState<Reading[]>([])
  const [passengerCounts, setPassengerCounts] = useState<PassengerCount[]>([])
  const [selectedStationId, setSelectedStationId] = useState('usj7')
  const [transitDepartures, setTransitDepartures] = useState<TransitDeparture[]>([])
  const [transitTimetable, setTransitTimetable] = useState<TimetableDeparture[]>([])
  const [transitRealtime, setTransitRealtime] = useState(false)
  const [transitStation, setTransitStation] = useState<TransitStation | null>(null)
  const [transitFetchedAt, setTransitFetchedAt] = useState('')
  const [transitLoading, setTransitLoading] = useState(true)
  const [transitError, setTransitError] = useState('')
  const [selectedBusRoute, setSelectedBusRoute] = useState(routes[0].route)
  const view = activeAccount?.defaultView ?? 'passenger'
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const savedTheme = localStorage.getItem('CoolStop-theme')
      if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
    } catch {
      // Keep the default theme when browser storage is unavailable.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [usingPreview, setUsingPreview] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [appLinkNotice, setAppLinkNotice] = useState<{ kind: 'voucher' | 'route' | 'alternatives'; value: string } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('CoolStop-theme', theme)
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    try {
      if (activeAccount) localStorage.setItem(DEMO_ACCOUNT_STORAGE_KEY, activeAccount.id)
      else localStorage.removeItem(DEMO_ACCOUNT_STORAGE_KEY)
    } catch {
      // Sample sign-in still works for this session when browser storage is unavailable.
    }
  }, [activeAccount])

  useEffect(() => {
    const readAppLink = () => {
      const match = window.location.hash.match(/^#(voucher|route|alternatives)=(.*)$/)
      if (!match) {
        setAppLinkNotice(null)
        return
      }
      try {
        setAppLinkNotice({ kind: match[1] as 'voucher' | 'route' | 'alternatives', value: decodeURIComponent(match[2]) })
      } catch {
        setAppLinkNotice(null)
      }
    }
    readAppLink()
    window.addEventListener('hashchange', readAppLink)
    return () => window.removeEventListener('hashchange', readAppLink)
  }, [])

  useEffect(() => {
    if (!activeAccount) return
    setLoading(true)
    setError('')
    setStreamConnected(false)
    let active = true
    let receivedSnapshot = false
    const stream = new EventSource(`${API}/events/telemetry`)
    stream.addEventListener('telemetry', (event) => {
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as { items?: Reading[]; passenger_counts?: PassengerCount[] }
        if (!Array.isArray(snapshot.items)) throw new Error('Unexpected telemetry response')
        receivedSnapshot = true
        setReadings(snapshot.items.length > 0 ? snapshot.items : previewReadings)
        setPassengerCounts(Array.isArray(snapshot.passenger_counts) ? snapshot.passenger_counts : [])
        setUsingPreview(snapshot.items.length === 0)
        setError('')
        setLoading(false)
      } catch {
        if (active) setError('Received an invalid telemetry update')
      }
    })
    stream.onopen = () => {
      if (!active) return
      setStreamConnected(true)
      setError('')
    }
    stream.onerror = () => {
      if (!active) return
      setStreamConnected(false)
      if (!receivedSnapshot) {
        setReadings(previewReadings)
        setPassengerCounts([])
        setUsingPreview(true)
        setLoading(false)
      }
      setError('Live telemetry stream disconnected; reconnecting…')
    }

    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      stream.close()
      window.clearInterval(clock)
    }
  }, [activeAccount])

  useEffect(() => {
    if (!activeAccount) return
    let active = true
    const loadDepartures = async () => {
      try {
        const response = await fetch(`${API}/transit/departures?station_id=${encodeURIComponent(selectedStationId)}`)
        if (!response.ok) throw new Error(`RapidKL transit request failed (${response.status})`)
        const data = await response.json() as { station: TransitStation; departures: TransitDeparture[]; timetable?: TimetableDeparture[]; fetched_at: string; realtime?: boolean }
        if (!Array.isArray(data.departures) || !data.station) throw new Error('Unexpected RapidKL transit response')
        if (active) {
          setTransitStation(data.station)
          setTransitFetchedAt(data.fetched_at)
          setTransitDepartures(data.departures)
          setTransitTimetable(Array.isArray(data.timetable) ? data.timetable : [])
          setTransitRealtime(data.realtime === true)
          setTransitError('')
        }
      } catch (cause) {
        if (active) {
          setTransitDepartures([])
          setTransitTimetable([])
          setTransitRealtime(false)
          setTransitError(cause instanceof Error ? cause.message : 'RapidKL schedule is unavailable')
        }
      } finally {
        if (active) setTransitLoading(false)
      }
    }
    setTransitLoading(true)
    loadDepartures()
    const refresh = window.setInterval(loadDepartures, 30_000)
    return () => {
      active = false
      window.clearInterval(refresh)
    }
  }, [activeAccount, selectedStationId])

  const latest = useMemo(() => latestPerStop(readings), [readings])
  const selectedStation = rapidKlStations.find((station) => station.id === selectedStationId) ?? rapidKlStations[0]
  const reading = latest.find((item) => normalizeStopName(item.device_id) === normalizeStopName(selectedStation.name))
  const stationName = transitStation?.name ?? selectedStation.name
  const routeOfferId = appLinkNotice?.kind === 'route' ? appLinkNotice.value.split('|').pop() ?? '' : ''
  const routeOffer = routeOfferId ? getOfferLinkDetails(routeOfferId) : null

  if (!activeAccount) {
    return <AuthScreen onSignIn={setActiveAccount} theme={theme} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="CoolStop home">
          <span className="brand-mark">C</span>
          <span>CoolStop<span className="brand-dot">.</span><small>Township transit, made better</small></span>
        </a>
        <div className="topbar-right">
          <span className={`connection ${error ? 'connection-offline' : ''}`}><i />{error ? 'Preview mode' : 'Demo system'}</span>
          <button type="button" className="theme-toggle" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-pressed={theme === 'dark'}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span><span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button>
          <div className="account-badge"><span className="avatar" aria-hidden="true">{activeAccount.initials}</span><span className="account-details"><strong>{activeAccount.name}</strong><small>{activeAccount.role}</small></span></div>
          <button type="button" className="sign-out-button" onClick={() => setActiveAccount(null)}>Sign out</button>
        </div>
      </header>

      <main className="main-content" id="home">
        <div className="page-heading">
          <div>
            <div className="eyebrow">TOWNSHIP MOBILITY · PROTOTYPE</div>
            <h1>A cooler, clearer<br className="mobile-break" /> way to wait.</h1>
            <p>Comfort conditions, bus arrivals and stop operations, all in one place.</p>
          </div>
          <div className="updated-pill"><span className={`pulse-dot ${streamConnected ? '' : 'pulse-dot-idle'}`} /> {streamConnected ? 'Live telemetry stream' : 'Connecting to live updates'}</div>
        </div>

        <div className={`demo-notice ${usingPreview ? 'preview-notice' : ''}`}>
          <span className="notice-icon">{usingPreview ? '◷' : 'i'}</span>
          <span><strong>{usingPreview ? 'PREVIEW DATA' : 'DEMO MODE'}</strong> — stop readings are {usingPreview ? 'example values shown because the API has no data' : 'simulated by the software device simulator'}. Arrivals use matching live vehicle positions when available; otherwise the app falls back to upcoming RapidKL GTFS static schedules, clearly labeled because actual arrival times may differ.{error && <small className="notice-error">API connection: {error}. Start FastAPI and simulator.py to load readings.</small>}</span>
        </div>
        {appLinkNotice && <div className="app-link-notice" role="status"><span><strong>{appLinkNotice.kind === 'voucher' ? `Sample voucher ${appLinkNotice.value}` : appLinkNotice.kind === 'route' && routeOffer ? `Directions to ${routeOffer.shop}` : appLinkNotice.kind === 'route' ? 'Sample shop directions opened' : `Sample journey alternatives from ${appLinkNotice.value}`}</strong><small>{appLinkNotice.kind === 'voucher' ? 'This demo code is not redeemable; a real voucher needs a participating shop integration.' : appLinkNotice.kind === 'route' && routeOffer ? `${routeOffer.walk} · ${routeOffer.route} · alight ${routeOffer.alight}. Sample only; live maps are not connected.` : 'This QR opens a prototype link. Live maps, transit routes and service disruption data are not connected.'}</small></span><button type="button" onClick={() => { window.location.hash = 'home'; setAppLinkNotice(null) }}>Dismiss</button></div>}

        <div className="view-switcher" role="group" aria-label="Your available view">
          <span className="active"><span aria-hidden="true">{viewIcons[view]}</span> {viewLabels[view]}</span>
        </div>

        <div className="stop-toolbar">
          <div className="stop-label"><span className="pin">⌖</span><span><strong>YOUR BUS STOP</strong><small>Selection updates stop conditions and GTFS arrivals</small></span></div>
          <label className="select-wrap"><span className="sr-only">Select bus stop</span><select value={selectedStationId} onChange={(event) => { setTransitDepartures([]); setTransitTimetable([]); setTransitRealtime(false); setTransitStation(null); setTransitLoading(true); setSelectedStationId(event.target.value) }}>{rapidKlStations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select><span className="select-chevron">⌄</span></label>
        </div>
        <div className="stop-toolbar transit-toolbar">
          <div className="stop-label"><span className="pin">⌖</span><span><strong>{transitRealtime ? 'LIVE-POSITION ARRIVAL ESTIMATES' : 'SCHEDULED ARRIVALS'}</strong><small>{transitLoading ? 'Loading RapidKL transit data…' : `${transitRealtime ? 'Live vehicle positions' : 'RapidKL GTFS static schedule'} · checked ${formatTimestamp(transitFetchedAt)}`}</small></span></div>
        </div>
        {transitError && <div className="notice-error" role="status">RapidKL transit data unavailable: {transitError}. Check that the backend can reach the official feed.</div>}
        {view === 'operations' ? <OperationsView readings={latest} reading={reading} departures={transitDepartures} stationName={stationName} loading={transitLoading} now={now} estimated={transitRealtime} /> : reading ? <>
          {view === 'passenger' && <PassengerView reading={reading} departures={transitDepartures} stationName={stationName} loading={transitLoading} error={transitError} now={now} estimated={transitRealtime} buses={routes} selectedBusRoute={selectedBusRoute} onBusChange={setSelectedBusRoute} report={passengerCounts.filter((report) => report.bus_route === selectedBusRoute).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0]} />}
          {view === 'screen' && <StopScreen reading={reading} departures={transitDepartures} stationName={stationName} loading={transitLoading} now={now} estimated={transitRealtime} route={selectedBusRoute} />}
        </> : <section className="passenger-grid">
          <TransitArrivalCard departures={transitDepartures} stationName={stationName} loading={transitLoading} error={transitError} now={now} estimated={transitRealtime} />
          <article className="comfort-card"><div className="section-heading"><div><span className="card-kicker">AT YOUR STOP</span><h2>Waiting conditions</h2></div></div><p>{loading && latest.length === 0 ? 'Connecting to the stop telemetry service…' : `No sensor readings are available for ${stationName} yet.`}</p></article>
        </section>}
        <TimetablePanel departures={transitTimetable} stationName={stationName} now={now} loading={transitLoading} />
        {view !== 'screen' && <SolarGeneration />}
        {view === 'operations' && <PassengerFlow reports={passengerCounts} buses={routes} selectedBusRoute={selectedBusRoute} onBusChange={setSelectedBusRoute} />}

        <footer className="footer"><span>CoolStop · Bus stop cooling and transit information prototype</span><span>Crowd level is waiting-area estimate, not onboard occupancy.</span></footer>
      </main>
    </div>
  )
}

function AuthScreen({ onSignIn, theme, onToggleTheme }: { onSignIn: (account: SampleAccount) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  return (
    <div className="app-shell auth-shell">
      <header className="topbar auth-topbar">
        <a className="brand" href="#home" aria-label="CoolStop home">
          <span className="brand-mark">C</span>
          <span>CoolStop<span className="brand-dot">.</span><small>Township transit, made better</small></span>
        </a>
        <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-pressed={theme === 'dark'}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span><span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button>
      </header>
      <main className="auth-main">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-eyebrow">WELCOME TO COOLSTOP</div>
          <h1 id="auth-title">Choose a sample account</h1>
          <p className="auth-intro">Sign in as a different user to explore the experience for each role.</p>
          <div className="sample-account-list">
            {sampleAccounts.map((account) => (
              <button type="button" className="sample-account-button" key={account.id} onClick={() => onSignIn(account)}>
                <span className="sample-account-avatar" aria-hidden="true">{account.initials}</span>
                <span className="sample-account-copy"><strong>{account.name}</strong><small>{account.role} · {account.description}</small></span>
                <span className="sample-account-arrow" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <p className="auth-disclaimer"><strong>Demo sign-in only.</strong> These sample profiles are stored in this browser and do not authenticate with the server. The API has no authentication.</p>
        </section>
      </main>
    </div>
  )
}

function TimetablePanel({ departures, stationName, now, loading }: { departures: TimetableDeparture[]; stationName: string; now: number; loading: boolean }) {
  return (
    <section className="timetable-panel" aria-labelledby="timetable-title">
      <div className="timetable-heading">
        <div><span className="card-kicker">RAPIDKL GTFS STATIC</span><h2 id="timetable-title">Full-day timetable · {stationName}</h2></div>
        <span className="timetable-count">{departures.length} listed</span>
      </div>
      {departures.length > 0 ? <>
        <details className="timetable-details">
          <summary>Show all {departures.length} entries · past and upcoming</summary>
          <div className="timetable-list" aria-label="Today's scheduled departures">
            {departures.map((departure) => {
              const past = new Date(departure.scheduled_at).getTime() < now
              const approximate = departure.frequency_based && departure.exact_times !== true
              return <div className={`timetable-row ${past ? 'timetable-past' : ''}`} key={`${departure.scheduled_at}-${departure.route}-${departure.destination}`}>
                <time dateTime={departure.scheduled_at}>{approximate ? '~' : ''}{departure.scheduled_time}</time>
                <span className="route-chip small">{departure.route}</span>
                <span className="timetable-destination">{departure.destination}<small>{departure.stop_name}</small></span>
                <span className={`timetable-status ${past ? 'past' : ''}`}>{past ? 'Passed' : 'Upcoming'}{departure.frequency_based ? ` · ${departure.headway_minutes} min frequency` : ''}</span>
              </div>
            })}
          </div>
        </details>
        <p className="timetable-note">Times are from the RapidKL static GTFS feed. Frequency-based entries marked “~” are approximate headway patterns, not guaranteed departure times; actual service may differ. No departures are invented for gaps in the feed.</p>
      </> : <p className="timetable-empty">{loading ? 'Loading today’s GTFS timetable…' : 'No scheduled service is listed for this stop today.'}</p>}
    </section>
  )
}

function scheduleTimeLabel(departure: TransitDeparture) {
  const approximate = departure.frequency_based && departure.exact_times !== true
  const frequency = departure.frequency_based && departure.headway_minutes
    ? ` · ${approximate ? 'approx. ' : ''}${departure.headway_minutes} min frequency`
    : ''
  return `${approximate ? '~' : ''}${departure.scheduled_time}${frequency}`
}

function TransitArrivalCard({ departures, stationName, loading, error, now, estimated }: { departures: TransitDeparture[]; stationName: string; loading: boolean; error: string; now: number; estimated: boolean }) {
  const nextBus = departures[0]
  const minutesUntil = (departure: TransitDeparture) => Math.max(0, Math.ceil((new Date(transitTimestamp(departure)).getTime() - now) / 60000))
  return (
    <article className="arrival-card">
      <div className="card-topline"><span className="card-kicker">{stationName} · {estimated ? 'LIVE ESTIMATE' : 'SCHEDULE'}</span><span className="simulated-tag">{estimated ? 'GPS-BASED' : 'RAPIDKL GTFS'}</span></div>
      {nextBus ? <>
        <div className="arrival-main"><div><span className="route-chip">{nextBus.route}</span><span className="destination">{nextBus.destination}</span></div><strong>{formatEta(minutesUntil(nextBus) * 60)}</strong></div>
        <div className="arrival-progress"><span style={{ width: `${Math.max(8, 100 - minutesUntil(nextBus) / 60 * 100)}%` }} /></div>
        <div className="arrival-foot"><span>{nextBus.stop_name}</span><span>{estimated ? `Estimated ${nextBus.scheduled_time}${nextBus.stale_position ? ` · ${lastPositionNote(nextBus)}` : ''}` : `Scheduled ${scheduleTimeLabel(nextBus)}`}</span></div>
        <div className="upcoming-list">{departures.slice(1, 3).map((bus) => <div className="upcoming-row" key={`${bus.route}-${bus.arrival_at ?? bus.scheduled_at}`}><span><b>{bus.route}</b> · {bus.destination} <small>{bus.stop_name}{bus.stale_position ? ` · ${lastPositionNote(bus)}` : !estimated ? ` · ${scheduleTimeLabel(bus)}` : ''}</small></span><strong>{formatEta(minutesUntil(bus) * 60)}</strong></div>)}</div>
      </> : <div className="bus-crowd-reading bus-crowd-inactive"><strong>{loading ? 'Loading transit data…' : error ? 'Transit data unavailable' : estimated ? 'No live vehicle estimate available' : 'No scheduled departures available'}</strong><span>{estimated ? 'Estimates use matching live positions or a last-known GPS location up to 10 minutes old.' : 'No upcoming service is listed in the current static RapidKL schedule.'}</span></div>}
    </article>
  )
}

function PassengerView({ reading, departures, stationName, loading, error, now, estimated, buses, selectedBusRoute, onBusChange, report }: { reading: Reading; departures: TransitDeparture[]; stationName: string; loading: boolean; error: string; now: number; estimated: boolean; buses: Route[]; selectedBusRoute: string; onBusChange: (route: string) => void; report?: PassengerCount }) {
  return (
    <section className="passenger-grid">
      <TransitArrivalCard departures={departures} stationName={stationName} loading={loading} error={error} now={now} estimated={estimated} />

      <article className="comfort-card">
        <div className="section-heading"><div><span className="card-kicker">AT YOUR STOP</span><h2>Waiting conditions</h2></div><span className="live-tag"><i /> {reading.crowd_source}</span></div>
        <div className="condition-grid">
          <Condition icon="☀" label="Air temperature" value={`${reading.temperature_c.toFixed(1)}°`} unit="C" tone="warm" detail="At the bus shelter" />
          <Condition icon="≈" label="Humidity" value={`${Math.round(reading.humidity_pct)}`} unit="%" tone="blue" detail="Relative humidity" />
          <Condition icon="♙" label="Waiting crowd" value={reading.crowd_level} unit="" tone="green" detail="People at this stop" />
        </div>
        <div className="comfort-tip"><span>✦</span><span><strong>{reading.cooler_on === null ? 'Cooling system status unavailable' : `Cooling system ${reading.cooler_on ? 'is running' : 'is on standby'}`}</strong><small>Comfort data last updated {formatTimestamp(reading.timestamp)}</small></span></div>
      </article>
      <article className="bus-crowd-card">
        <div className="bus-crowd-heading"><div><span className="card-kicker">DOORWAY-BASED ONBOARD ESTIMATE</span><strong>{buses.find((bus) => bus.route === selectedBusRoute)?.destination ?? 'Selected bus'}</strong></div><label>Bus<select aria-label="Select bus for onboard estimate" value={selectedBusRoute} onChange={(event) => onBusChange(event.target.value)}>{buses.map((bus) => <option key={bus.route} value={bus.route}>{bus.route} · {bus.destination}</option>)}</select></label></div>
        {report && report.occupancy_count !== null ? <div className="bus-crowd-reading"><strong>{report.occupancy_count} estimated onboard</strong><span>{report.status === 'ok' ? 'Latest counter report' : `Counter ${report.status}`} · updated {formatTimestamp(report.observed_at)}</span></div> : <div className="bus-crowd-reading bus-crowd-inactive"><strong>Unavailable</strong><span>No doorway counter report is associated with this route yet.</span></div>}
        <small className="bus-crowd-note">This estimates occupancy from the counter's starting count and observed doorway crossings. It does not count everyone waiting at the stop or account for people already onboard unless initialized.</small>
      </article>
      <TargetedAdvertisements stopId={reading.device_id} route={selectedBusRoute} crowdLevel={reading.crowd_level} temperatureC={reading.temperature_c} />
      <EhailingCompare stopId={reading.device_id} />
    </section>
  )
}

function Condition({ icon, label, value, unit, tone, detail }: { icon: string; label: string; value: string; unit: string; tone: string; detail: string }) {
  return <div className="condition-item"><span className={`condition-icon ${tone}`}>{icon}</span><span className="condition-label">{label}</span><strong className="condition-value">{value}<small>{unit}</small></strong><span className="condition-detail">{detail}</span></div>
}

function PassengerFlow({ reports, buses, selectedBusRoute, onBusChange }: { reports: PassengerCount[]; buses: Route[]; selectedBusRoute: string; onBusChange: (route: string) => void }) {
  const [sessions, setSessions] = useState<PassengerCountSession[]>([])
  useEffect(() => {
    let active = true
    const loadSessions = async () => {
      try {
        const response = await fetch(`${API}/passenger-count-sessions?limit=20`)
        if (!response.ok) return
        const payload = await response.json() as { items?: PassengerCountSession[] }
        if (active) setSessions(payload.items ?? [])
      } catch {
        if (active) setSessions([])
      }
    }
    void loadSessions()
    const interval = window.setInterval(() => void loadSessions(), 15_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [])
  return (
    <section className="passenger-flow-panel" aria-labelledby="passenger-flow-title">
      <div className="passenger-flow-heading">
        <div><span className="card-kicker">ONBOARD PASSENGER FLOW</span><h2 id="passenger-flow-title">Doorway counter reports</h2></div>
        <span className="flow-separation-note">Separate from people waiting at the stop</span>
      </div>
      <LiveCameraCounter apiUrl={API} buses={buses} selectedBusRoute={selectedBusRoute} onBusChange={onBusChange} />
      {reports.length === 0 ? (
        <div className="flow-empty">No doorway counter reports yet. Start the browser webcam counter above or the optional Python counter on the camera host.</div>
      ) : (
        <div className="flow-camera-list">
          {reports.map((report) => {
            const observed = new Date(report.observed_at).getTime()
            const stale = !Number.isFinite(observed) || Date.now() - observed > 30000
            const status = stale && report.status === 'ok' ? 'stale' : report.status
            const confidence = Math.max(0, Math.min(1, report.confidence))
            return (
              <article className="flow-camera" key={report.camera_id}>
                <div className="flow-camera-title"><strong>{report.camera_id}</strong><span className={`flow-status flow-status-${status}`}>{status}</span></div>
                <small className="flow-updated">Route {report.bus_route ?? 'not assigned'}</small>
                <div className="flow-counts">
                  <div><span>Boarding</span><strong>{report.boarding_count}</strong></div>
                  <div><span>Alighting</span><strong>{report.alighting_count}</strong></div>
                  <div><span>Estimated occupancy</span><strong>{typeof report.occupancy_count === 'number' ? report.occupancy_count : '—'}</strong></div>
                </div>
                <div className="flow-confidence"><span>Detector confidence <strong>{Math.round(confidence * 100)}%</strong></span><div><i style={{ width: `${confidence * 100}%` }} /></div></div>
                <small className="flow-updated">Updated {formatTimestamp(report.observed_at)}</small>
              </article>
            )
          })}
        </div>
      )}
      <div className="passenger-history">
        <div className="passenger-flow-heading"><div><span className="card-kicker">SERVER-SAVED HISTORY</span><h3>Recent camera sessions</h3></div><span className="flow-separation-note">Latest count snapshots · refreshes every 15 seconds</span></div>
        {sessions.length === 0 ? <div className="flow-empty">No saved sessions yet. Configure Supabase persistence on the backend to keep history between deployments.</div> : (
          <div className="flow-camera-list">
            {sessions.map((session) => (
              <article className="flow-camera" key={session.session_id}>
                <div className="flow-camera-title"><strong>{session.camera_id} · Route {session.bus_route ?? '—'}</strong><span className={`flow-status flow-status-${session.status}`}>{session.status}</span></div>
                <small className="flow-updated">Started {formatTimestamp(session.started_at)}{session.ended_at ? ` · ended ${formatTimestamp(session.ended_at)}` : ''}</small>
                {session.latest_snapshot ? <div className="flow-counts">
                  <div><span>Detected now</span><strong>{session.latest_snapshot.detected_now}</strong></div>
                  <div><span>Total detected</span><strong>{session.latest_snapshot.total_detected}</strong></div>
                  <div><span>Boarding</span><strong>{session.latest_snapshot.boarding_count}</strong></div>
                  <div><span>Alighting</span><strong>{session.latest_snapshot.alighting_count}</strong></div>
                </div> : <small className="flow-updated">No count snapshot recorded.</small>}
                {session.latest_snapshot && <small className="flow-updated">Last snapshot {formatTimestamp(session.latest_snapshot.observed_at)} · occupancy {session.latest_snapshot.occupancy_count}</small>}
              </article>
            ))}
          </div>
        )}
      </div>
      <p className="flow-disclaimer">The browser counter uses COCO-SSD with local browser-side tracking and only counts crossings inside the manually marked doorway area and configured line; its calibration is saved on that device for each camera. The optional Python counter uses YOLO with ByteTrack. Boarding, alighting, and occupancy are estimates, not a count of people waiting at the stop. Occupancy starts at the configured initial count and does not change when a track merely disappears. Confidence is a detector score, not a calibrated accuracy guarantee.</p>
    </section>
  )
}

function StopScreen({ reading, departures, stationName, loading, now, estimated, route }: { reading: Reading; departures: TransitDeparture[]; stationName: string; loading: boolean; now: number; estimated: boolean; route: string }) {
  const minutesUntil = (departure: TransitDeparture) => Math.max(0, Math.ceil((new Date(transitTimestamp(departure)).getTime() - now) / 60000))
  return (
    <section className="screen-wrap">
      <div className="screen-device">
        <div className="screen-header"><span className="screen-logo">C</span><span>CoolStop <small>SMART BUS STOP</small></span><span className="screen-clock">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
        <div className="screen-content-grid">
          <section className="screen-arrivals-panel" aria-label="Upcoming bus arrivals">
            <div className="screen-next-label">{stationName} · {estimated ? 'LIVE ESTIMATE' : 'SCHEDULE'} <span className="simulated-tag">{estimated ? 'GPS-BASED' : 'RAPIDKL GTFS'}</span></div>
            <div className="screen-arrivals">
              {departures.length > 0 ? departures.map((bus) => (
                <article className="screen-arrival-card" key={`${bus.route}-${bus.arrival_at ?? bus.scheduled_at}`}>
                  <div className="screen-arrival-card-top"><span className="screen-route small">{bus.route}</span><strong>{formatEta(minutesUntil(bus) * 60)}</strong></div>
                  <span className="screen-arrival-destination">{bus.destination} · {estimated ? `Estimated ${bus.scheduled_time}` : `Scheduled ${scheduleTimeLabel(bus)}`}{bus.stale_position ? ` · ${lastPositionNote(bus)}` : ''}</span>
                </article>
              )) : <p>{loading ? 'Loading RapidKL transit data…' : estimated ? 'No live vehicle estimate available from positions up to 10 minutes old.' : 'No upcoming scheduled departures are listed.'}</p>}
            </div>
          </section>
        </div>
        <section className="screen-energy-panel" aria-label="Sample energy consumption">
            <div className="screen-energy-heading"><span>ENERGY USE</span><span className="simulated-tag">SAMPLE</span></div>
            <div className="screen-energy-total"><strong>1.90 <small>kWh/day</small></strong><span>155 W reference rated load</span></div>
            <div className="screen-energy-loads">
              <div><span>Fan · 120 W</span><strong>1.44</strong></div>
              <div><span>LED lighting · 20 W</span><strong>0.28</strong></div>
              <div><span>Controls + sensors · 15 W</span><strong>0.18</strong></div>
              <div><span>Water pump · 0 W</span><strong>0</strong></div>
            </div>
            <small className="screen-energy-note">kWh/day · illustrative reference values. Display wattage not separately specified.</small>
        </section>
        <div className="screen-info"><span><i className="screen-sun">☀</i> {reading.temperature_c.toFixed(1)}°C <small>Temperature</small></span><span><i className="screen-humidity">≈</i> {Math.round(reading.humidity_pct)}% <small>Humidity</small></span><span><i className="screen-crowd">♙</i> {reading.crowd_level} <small>Waiting crowd</small></span></div>
        <TargetedAdvertisements stopId={reading.device_id} route={route} crowdLevel={reading.crowd_level} temperatureC={reading.temperature_c} screen />
        <div className="screen-footer">{estimated ? 'GPS-based arrival estimates · Not official predictions' : 'Scheduled departures from RapidKL GTFS · Actual arrivals may differ'} · Scan an ad QR to continue on your phone</div>
      </div>
      <div className="screen-notes"><span className="screen-note-icon">▣</span><div><strong>Designed for a quick glance</strong><p>{estimated ? 'USJ 7 estimates use live vehicle positions and route geometry; they are not official trip predictions.' : 'Scheduled departures are sourced from RapidKL static GTFS; actual bus arrival times may differ.'}</p></div></div>
    </section>
  )
}

function OperationsView({ readings, reading, departures, stationName, loading, now, estimated }: { readings: Reading[]; reading: Reading | undefined; departures: TransitDeparture[]; stationName: string; loading: boolean; now: number; estimated: boolean }) {
  const fault = reading?.fault_code
  const minutesUntil = (departure: TransitDeparture) => Math.max(0, Math.ceil((new Date(transitTimestamp(departure)).getTime() - now) / 60000))
  const state = !reading ? 'No telemetry' : fault ? 'Needs attention' : reading.cooler_on === null ? 'Partial telemetry' : reading.cooler_on ? 'Cooling active' : 'Standby'
  return (
    <section className="operations-view">
      <div className="operations-heading"><div><span className="card-kicker">FLEET MONITOR</span><h2>Stop operations</h2></div><span className={`state-badge ${fault ? 'fault' : ''}`}><i />{state}</span></div>
      <div className="ops-grid">
        <OpsMetric label="Air temperature" value={reading ? `${reading.temperature_c.toFixed(1)} °C` : 'Unavailable'} icon="☀" note={reading ? 'Shelter sensor' : 'No sensor reading for this stop'} />
        <OpsMetric label="Relative humidity" value={reading ? `${reading.humidity_pct.toFixed(1)}%` : 'Unavailable'} icon="≈" note={reading ? 'Shelter sensor' : 'No sensor reading for this stop'} />
        <OpsMetric label="Water remaining" value={!reading || reading.water_level_pct === null ? 'Not reported' : `${reading.water_level_pct.toFixed(0)}%`} icon="♧" note={!reading || reading.water_level_pct === null ? 'No water sensor' : reading.water_level_pct < 20 ? 'Refill required' : 'Tank level'} alert={Boolean(reading && reading.water_level_pct !== null && reading.water_level_pct < 20)} />
        <OpsMetric label="Power draw" value={!reading || reading.power_w === null ? 'Not reported' : `${reading.power_w.toFixed(1)} W`} icon="ϟ" note={!reading || reading.power_w === null ? 'No power sensor' : 'Cooling equipment'} />
      </div>
      {fault && <div className="fault-banner"><strong>Fault reported: {fault}</strong><span>Inspect the device and confirm water and sensor status.</span></div>}
      <div className="ops-lower-grid">
        <article className="ops-panel"><div className="panel-heading"><div><span className="card-kicker">{estimated ? 'RAPIDKL LIVE POSITIONS' : 'RAPIDKL GTFS STATIC'}</span><h3>{stationName} {estimated ? 'arrival estimates' : 'departures'}</h3></div><span className="simulated-tag">{estimated ? 'ESTIMATED' : 'SCHEDULED'}</span></div>{departures.length > 0 ? departures.slice(0, 3).map((bus) => <div className="service-row" key={`${bus.route}-${bus.arrival_at ?? bus.scheduled_at}`}><span className="route-chip small">{bus.route}</span><span className="service-destination">{bus.destination}{bus.stale_position && <small> · {lastPositionNote(bus)}</small>}</span><strong>{formatEta(minutesUntil(bus) * 60)}</strong></div>) : <p>{loading ? 'Loading transit data…' : estimated ? 'No live vehicle estimate available from positions up to 10 minutes old.' : 'No upcoming scheduled departures are listed.'}</p>}<p className="panel-footnote">{estimated ? 'GPS-based estimates from vehicle positions; last-known positions are labeled and limited to 10 minutes. These are not official trip predictions.' : 'Scheduled departures from RapidKL GTFS static; actual arrival times may differ.'}</p></article>
        <article className="ops-panel"><div className="panel-heading"><div><span className="card-kicker">DEVICE HEALTH</span><h3>{reading?.device_id ?? stationName}</h3></div><span className="device-dot"><i /> {reading ? 'Online' : 'No data'}</span></div><div className="health-row"><span>Waiting-area crowd</span><strong>{reading?.crowd_level ?? 'Unavailable'}</strong></div><div className="health-row"><span>Crowd data source</span><strong>{reading?.crowd_source ?? 'No sensor reading'}</strong></div><div className="health-row"><span>Last sensor update</span><strong>{reading ? formatTimestamp(reading.timestamp) : 'Unavailable'}</strong></div><div className="health-row"><span>Cooler state</span><strong>{!reading || reading.cooler_on === null ? 'Not reported' : reading.cooler_on ? 'On' : 'Off'}</strong></div></article>
      </div>
      <div className="site-summary"><div><strong>{readings.length}</strong><span>stops reporting</span></div><div><strong>{readings.filter((item) => item.cooler_on).length}</strong><span>coolers running</span></div><div><strong>{readings.filter((item) => Boolean(item.fault_code)).length}</strong><span>faults reported</span></div><small>Live server-pushed telemetry · Demonstration values only</small></div>
      <AdvertisementOperations currentStopId={reading?.device_id ?? stationName} />
    </section>
  )
}

function OpsMetric({ label, value, icon, note, alert = false }: { label: string; value: string; icon: string; note: string; alert?: boolean }) {
  return <article className={`ops-metric ${alert ? 'metric-alert' : ''}`}><span className="ops-icon">{icon}</span><span className="ops-label">{label}</span><strong>{value}</strong><small>{note}</small></article>
}

function SolarGeneration() {
  return (
    <section className="solar-panel" aria-labelledby="solar-title">
      <div className="solar-heading">
        <div><span className="card-kicker">SOLAR ENERGY · REFERENCE VALUES</span><h2 id="solar-title">Generation &amp; energy use</h2></div>
        <span className="simulated-tag">ILLUSTRATIVE ONLY</span>
      </div>
      <div className="solar-metrics">
        <div><span>Solar generation reading</span><strong className="solar-pending">Awaiting panel specs</strong></div>
        <div><span>Reference total rated load</span><strong>155 <small>W</small></strong></div>
        <div><span>Reference energy use</span><strong>1.90 <small>kWh/day</small></strong></div>
      </div>
      <div className="energy-breakdown" aria-label="Illustrative reference energy consumption breakdown">
        <div className="energy-breakdown-heading"><strong>Reference load and daily consumption</strong><span>Assumptions from supplied reference</span></div>
        <div className="energy-row"><span><strong>Centrifugal fan</strong><small>120 W · 12 h/day</small></span><b>1.44 kWh/day</b></div>
        <div className="energy-row"><span><strong>LED lighting</strong><small>20 W · 14 h/day</small></span><b>0.28 kWh/day</b></div>
        <div className="energy-row"><span><strong>Controls + sensors</strong><small>15 W · 12 h/day</small></span><b>0.18 kWh/day</b></div>
        <div className="energy-row"><span><strong>Water pump</strong><small>0 W · gravity-fed</small></span><b>0 kWh/day</b></div>
      </div>
      <div className="energy-reference-summary"><span>57 kWh/month</span><span>694 kWh/year</span><span>RM 315/year at RM 0.454/kWh</span><span>526 kgCO₂e/year reference emissions</span></div>
      <p>These are illustrative figures from the supplied reference, not site measurements. Daily use assumes fan 12 h, lights 14 h, and controls/sensors 12 h. No separate display wattage is provided—15 W is for controls + sensors, not a confirmed display rating. Solar generation, output, and panel sizing are not available until engineering specifications are provided.</p>
    </section>
  )
}

export default App
