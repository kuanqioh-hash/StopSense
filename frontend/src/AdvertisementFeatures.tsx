import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

const API = import.meta.env.VITE_API_URL || '/api'
type Advertisement = {
  id: number
  advertiser: string
  title: string
  detail: string
  active: boolean
  stop_ids: string[]
  facility_tags: string[]
  routes: string[]
  crowd_levels: string[]
  time_slots: string[]
  min_temperature_c: number | null
  max_temperature_c: number | null
  busy_only: boolean
  relevance_score?: number
  match_reasons?: string[]
}
type Inquiry = { id: number; name: string; email: string; organization: string | null; message: string; status: 'new' | 'contacted' | 'closed'; created_at: string }
type StopProfile = { stop_id: string; latitude: number | null; longitude: number | null; radius_m: number; facilities: string[] }
type AdContext = { radius_m: number; traffic_score: number; traffic_source: string }
type Draft = Omit<Advertisement, 'id' | 'relevance_score' | 'match_reasons'>

const blankDraft = (): Draft => ({ advertiser: '', title: '', detail: '', active: true, stop_ids: [], facility_tags: [], routes: [], crowd_levels: [], time_slots: [], min_temperature_c: null, max_temperature_c: null, busy_only: false })
const csv = (value: string[]) => value.join(', ')
const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean)

export function TargetedAdvertisements({ stopId, route, crowdLevel, temperatureC, screen = false }: { stopId: string; route: string; crowdLevel: string; temperatureC: number; screen?: boolean }) {
  const [items, setItems] = useState<Advertisement[]>([])
  const [context, setContext] = useState<AdContext | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ stop_id: stopId, route, crowd_level: crowdLevel, temperature_c: String(temperatureC) })
      const response = await fetch(`${API}/advertisements/recommendations?${params}`)
      if (!response.ok) throw new Error(`Recommendations unavailable (${response.status})`)
      const data = await response.json() as { items: Advertisement[]; context: AdContext }
      setItems(data.items)
      setContext(data.context)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recommendations unavailable')
    }
  }, [stopId, route, crowdLevel, temperatureC])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60000)
    return () => window.clearInterval(timer)
  }, [load])

  return <section className={`targeted-ad-panel ${screen ? 'targeted-ad-screen' : ''}`} aria-label="Targeted advertisements">
    <div className="targeted-ad-heading"><div><span className="card-kicker">LOCAL PICKS · CONTEXTUAL ADS</span><h2>{screen ? 'Around this stop' : 'Relevant nearby offers'}</h2></div><span className="simulated-tag">{context ? `WITHIN ${context.radius_m} M` : 'DEMO'}</span></div>
    {error && <p className="ad-status" role="status">{error}. Existing campaign data may be unavailable.</p>}
    {items.length ? <div className="targeted-ad-list">{items.slice(0, screen ? 2 : 3).map((ad) => <article className="targeted-ad-item" key={ad.id}>
      <span className="targeted-ad-mark" aria-hidden="true">✦</span><div><small>{ad.advertiser} · SPONSORED</small><strong>{ad.title}</strong><p>{ad.detail}</p>{ad.match_reasons?.length && !ad.match_reasons.includes('General fallback; no contextual match') ? <small className="ad-match-reasons">Matched: {ad.match_reasons.join(' · ')}</small> : null}</div>
    </article>)}</div> : !error ? <p className="ad-status">No active campaign matches this stop and current conditions yet.</p> : null}
    {context && <small className="ad-data-note">Uses dashboard crowd/temperature, route, local time, editable nearby-facility tags and aggregate camera-count patterns. {context.traffic_source}; traffic fit {Math.round(context.traffic_score * 100)}%. Estimates only.</small>}
    {!screen && <AdvertiserInquiryForm />}
  </section>
}

function AdvertiserInquiryForm() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const form = event.currentTarget
    const values = new FormData(form)
    try {
      const response = await fetch(`${API}/advertisement-inquiries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: values.get('name'), email: values.get('email'), organization: values.get('organization') || null, message: values.get('message') }) })
      if (!response.ok) throw new Error('Could not send inquiry. Please try again later.')
      form.reset()
      setMessage('Thanks — your placement inquiry has been sent to the operations team.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not send inquiry.')
    } finally {
      setBusy(false)
    }
  }
  return <details className="advertiser-contact"><summary>Interested in placing an advertisement? Contact us</summary><form onSubmit={submit}>
    <label>Your name<input name="name" required maxLength={120} /></label><label>Email<input name="email" type="email" required maxLength={254} /></label><label>Organization (optional)<input name="organization" maxLength={120} /></label><label className="ad-message-field">How can we help?<textarea name="message" required minLength={10} maxLength={2000} rows={3} /></label>
    <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send placement inquiry'}</button>{message && <small role="status">{message}</small>}
  </form></details>
}

export function AdvertisementOperations({ currentStopId }: { currentStopId: string }) {
  const [ads, setAds] = useState<Advertisement[]>([])
  const [inquiries, setInquiries] = useState<Inquiry[]>([])
  const [profiles, setProfiles] = useState<StopProfile[]>([])
  const [draft, setDraft] = useState<Draft>(blankDraft())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<StopProfile>({ stop_id: currentStopId, latitude: null, longitude: null, radius_m: 500, facilities: [] })

  const refresh = useCallback(async () => {
    try {
      const [adResponse, inquiryResponse, profileResponse] = await Promise.all([fetch(`${API}/advertisements`), fetch(`${API}/advertisement-inquiries`), fetch(`${API}/stop-ad-profiles`)] )
      if (![adResponse, inquiryResponse, profileResponse].every((response) => response.ok)) throw new Error('Unable to load operations data')
      const [adData, inquiryData, profileData] = await Promise.all([adResponse.json(), inquiryResponse.json(), profileResponse.json()]) as [{ items: Advertisement[] }, { items: Inquiry[] }, { items: StopProfile[] }]
      setAds(adData.items)
      setInquiries(inquiryData.items)
      setProfiles(profileData.items)
      setNotice('')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Unable to load operations data')
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  function startEdit(ad: Advertisement) {
    setEditingId(ad.id)
    const { id: _id, relevance_score: _score, match_reasons: _reasons, ...fields } = ad
    setDraft(fields)
  }
  async function saveAd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    const form = event.currentTarget
    const formValues = new FormData(form)
    const value = (name: string) => String(formValues.get(name) ?? '')
    const payload: Draft = { ...draft,
      stop_ids: list(value('stop_ids')),
      facility_tags: list(value('facility_tags')),
      routes: list(value('routes')),
      crowd_levels: list(value('crowd_levels')),
      time_slots: list(value('time_slots')),
    }
    try {
      const response = await fetch(`${API}/advertisements${editingId ? `/${editingId}` : ''}`, { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error(`Save failed (${response.status}); check targeting values.`)
      form.reset()
      setDraft(blankDraft())
      setEditingId(null)
      await refresh()
      setNotice('Advertisement saved.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not save advertisement.')
    } finally { setBusy(false) }
  }
  async function deleteAd(id: number) {
    if (!window.confirm('Delete this advertisement?')) return
    const response = await fetch(`${API}/advertisements/${id}`, { method: 'DELETE' })
    if (response.ok) await refresh()
    else setNotice('Could not delete advertisement.')
  }
  async function updateInquiry(id: number, status: Inquiry['status']) {
    const response = await fetch(`${API}/advertisement-inquiries/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    if (response.ok) await refresh()
    else setNotice('Could not update inquiry status.')
  }
  function editProfile(item: StopProfile) { setProfile(item) }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const response = await fetch(`${API}/stop-ad-profiles/${encodeURIComponent(profile.stop_id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
    if (response.ok) { await refresh(); setNotice('Stop profile saved.') }
    else setNotice('Could not save stop profile; coordinates must be both set or both blank.')
  }

  return <section className="ad-operations" aria-labelledby="ad-operations-title">
    <div className="operations-heading"><div><span className="card-kicker">ADVERTISING WORKSPACE</span><h2 id="ad-operations-title">Campaigns &amp; inquiries</h2></div><span className="simulated-tag">PROTOTYPE</span></div>
    <p className="ad-admin-warning"><strong>Prototype access:</strong> management APIs are not authenticated. Do not expose this deployment or enter sensitive personal information until server-side authentication and privacy controls are added.</p>
    {notice && <p className="ad-status" role="status">{notice}</p>}
    <div className="ad-admin-grid"><article className="ad-admin-card"><h3>{editingId ? 'Edit advertisement' : 'Create advertisement'}</h3><form key={editingId ?? 'new-ad'} className="ad-admin-form" onSubmit={saveAd}>
      <label>Advertiser<input required maxLength={120} value={draft.advertiser} onChange={(event) => setDraft({ ...draft, advertiser: event.target.value })} /></label><label>Ad title<input required maxLength={140} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label className="ad-wide">Message<textarea required maxLength={500} value={draft.detail} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} /></label>
      <label>Stop IDs, comma-separated<input name="stop_ids" defaultValue={csv(draft.stop_ids)} placeholder="demo-stop-01" /></label><label>Nearby facilities / tags<input name="facility_tags" defaultValue={csv(draft.facility_tags)} placeholder="food, cafe, mall" /></label><label>Routes<input name="routes" defaultValue={csv(draft.routes)} placeholder="752, T1" /></label><label>Crowd levels<input name="crowd_levels" defaultValue={csv(draft.crowd_levels)} placeholder="High, Moderate" /></label><label>Time slots<input name="time_slots" defaultValue={csv(draft.time_slots)} placeholder="breakfast, lunch, commute, evening, all-day" /></label>
      <label>Min temp °C<input type="number" min={-20} max={70} value={draft.min_temperature_c ?? ''} onChange={(event) => setDraft({ ...draft, min_temperature_c: event.target.value === '' ? null : Number(event.target.value) })} /></label><label>Max temp °C<input type="number" min={-20} max={70} value={draft.max_temperature_c ?? ''} onChange={(event) => setDraft({ ...draft, max_temperature_c: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      <label className="ad-check"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Active</label><label className="ad-check"><input type="checkbox" checked={draft.busy_only} onChange={(event) => setDraft({ ...draft, busy_only: event.target.checked })} /> Only during historically busy periods</label>
      <div className="ad-form-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Update advertisement' : 'Add advertisement'}</button>{editingId && <button type="button" className="secondary-action" onClick={() => { setEditingId(null); setDraft(blankDraft()) }}>Cancel edit</button>}</div>
    </form></article>
    <article className="ad-admin-card"><h3>Stop profiles</h3><p>Set nearby facility tags and an optional radius for location relevance. Coordinates are stored for future location integrations; no external place lookup is active.</p><form className="ad-admin-form" onSubmit={saveProfile}>
      <label>Stop / sensor ID<input required maxLength={64} value={profile.stop_id} onChange={(event) => setProfile({ ...profile, stop_id: event.target.value })} /></label><label>Radius (m)<input type="number" min={50} max={5000} value={profile.radius_m} onChange={(event) => setProfile({ ...profile, radius_m: Number(event.target.value) })} /></label><label>Latitude (optional)<input type="number" min={-90} max={90} value={profile.latitude ?? ''} onChange={(event) => setProfile({ ...profile, latitude: event.target.value === '' ? null : Number(event.target.value) })} /></label><label>Longitude (optional)<input type="number" min={-180} max={180} value={profile.longitude ?? ''} onChange={(event) => setProfile({ ...profile, longitude: event.target.value === '' ? null : Number(event.target.value) })} /></label><label className="ad-wide">Facility tags<input value={csv(profile.facilities)} onChange={(event) => setProfile({ ...profile, facilities: list(event.target.value) })} placeholder="rail, mall, university, cafe" /></label><button type="submit">Save stop profile</button>
    </form><ul className="ad-profile-list">{profiles.map((item) => <li key={item.stop_id}><button type="button" onClick={() => editProfile(item)}>{item.stop_id} · {item.radius_m} m · {item.facilities.join(', ') || 'no facility tags'}</button></li>)}</ul></article></div>
    <article className="ad-admin-card ad-inquiry-card"><div className="panel-heading"><div><span className="card-kicker">ADVERTISER CONTACT</span><h3>Placement inquiries ({inquiries.length})</h3></div><button type="button" className="secondary-action" onClick={() => void refresh()}>Refresh</button></div>{inquiries.length ? <div className="ad-inquiry-list">{inquiries.map((item) => <article key={item.id}><div><strong>{item.name}</strong>{item.organization && <span>{item.organization}</span>}<a href={`mailto:${encodeURIComponent(item.email)}`}>{item.email}</a><small>{new Date(item.created_at).toLocaleString()}</small><p>{item.message}</p></div><label>Status<select value={item.status} onChange={(event) => void updateInquiry(item.id, event.target.value as Inquiry['status'])}><option value="new">New</option><option value="contacted">Contacted</option><option value="closed">Closed</option></select></label></article>)}</div> : <p>No inquiries received.</p>}</article>
    <div className="ad-campaign-list"><h3>Manage campaigns ({ads.length})</h3>{ads.map((ad) => <article key={ad.id}><div><strong>{ad.title}</strong><span>{ad.advertiser} · {ad.active ? 'Active' : 'Paused'}</span><small>{ad.match_reasons?.join(' · ') || [ad.routes.join(', '), ad.stop_ids.join(', '), ad.facility_tags.join(', ')].filter(Boolean).join(' · ') || 'General targeting'}</small></div><div><button type="button" onClick={() => startEdit(ad)}>Edit</button><button type="button" className="danger-action" onClick={() => void deleteAd(ad.id)}>Delete</button></div></article>)}</div>
  </section>
}
