import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { trackPeople, type CounterDetection as Detection, type CounterTrack as Track } from './counterTracking.js'

type Counts = { boarding: number; alighting: number; occupancy: number }
type Bus = { route: string; destination: string }
type CameraDevice = { id: string; label: string }
type Orientation = 'horizontal' | 'vertical'
type Direction = 'up' | 'down' | 'left' | 'right'
type DoorRegion = { left: number; top: number; right: number; bottom: number }
type NormalizedPoint = { x: number; y: number }

const CAMERA_ID = 'browser-camera-01'
const DOOR_REGION_STORAGE_KEY = 'stopsense-door-region'
const MIN_DOOR_REGION_SIZE = 0.02

function readDoorRegion(cameraId: string): DoorRegion | null {
  try {
    const value = localStorage.getItem(`${DOOR_REGION_STORAGE_KEY}:${cameraId}`)
    if (!value) return null
    const region = JSON.parse(value) as DoorRegion
    if ([region.left, region.top, region.right, region.bottom].every((edge) => Number.isFinite(edge) && edge >= 0 && edge <= 1)
      && region.right - region.left >= MIN_DOOR_REGION_SIZE
      && region.bottom - region.top >= MIN_DOOR_REGION_SIZE) return region
  } catch {
    return null
  }
  return null
}
const DEFAULT_POSITION = 55
const DEFAULT_CONFIDENCE = 0.4
const MAX_DETECTIONS_PER_FRAME = 100

export default function LiveCameraCounter({ apiUrl, buses, selectedBusRoute, onBusChange }: { apiUrl: string; buses: Bus[]; selectedBusRoute: string; onBusChange: (route: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mountedRef = useRef(true)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const tracksRef = useRef<Map<number, Track>>(new Map())
  const nextTrackIdRef = useRef(1)
  const frameRef = useRef(0)
  const modelRef = useRef<{ detect: (video: HTMLVideoElement, maxNumBoxes: number, minScore: number) => Promise<Detection[]> } | null>(null)
  const modelPromiseRef = useRef<Promise<{ detect: (video: HTMLVideoElement, maxNumBoxes: number, minScore: number) => Promise<Detection[]> }> | null>(null)
  const lastCrossingAtRef = useRef(0)
  const countsRef = useRef<Counts>({ boarding: 0, alighting: 0, occupancy: 0 })
  const confidenceRef = useRef({ sum: 0, count: 0 })
  const sessionIdRef = useRef<string | null>(null)
  const snapshotIdRef = useRef<string | null>(null)
  const lastSnapshotAtRef = useRef(0)
  const lastSnapshotSignatureRef = useRef('')
  const publishInFlightRef = useRef(false)
  const detectedPeopleRef = useRef(0)
  const totalDetectedPeopleRef = useRef(0)
  const selectedBusRouteRef = useRef(selectedBusRoute)
  const previousBusRouteRef = useRef(selectedBusRoute)
  selectedBusRouteRef.current = selectedBusRoute
  const [counts, setCounts] = useState<Counts>(countsRef.current)
  const [detectedPeople, setDetectedPeople] = useState(0)
  const [totalDetectedPeople, setTotalDetectedPeople] = useState(0)
  const [state, setState] = useState<'idle' | 'starting' | 'active' | 'error'>('idle')
  const stateRef = useRef(state)
  stateRef.current = state
  const [message, setMessage] = useState('')
  const [initialOccupancy, setInitialOccupancy] = useState(0)
  const [orientation, setOrientation] = useState<Orientation>('horizontal')
  const [linePosition, setLinePosition] = useState(DEFAULT_POSITION)
  const [confidenceThreshold, setConfidenceThreshold] = useState(DEFAULT_CONFIDENCE)
  const [enteringDirection, setEnteringDirection] = useState<Direction>('up')
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment')
  const [doorRegion, setDoorRegion] = useState<DoorRegion | null>(null)
  const doorRegionRef = useRef<DoorRegion | null>(null)
  const [isCalibratingDoor, setIsCalibratingDoor] = useState(false)
  const [doorDragStart, setDoorDragStart] = useState<NormalizedPoint | null>(null)
  const draftDoorRegionRef = useRef<DoorRegion | null>(null)

  const updateDraftDoorRegion = (region: DoorRegion | null) => {
    draftDoorRegionRef.current = region
  }

  const getNormalizedPoint = (event: ReactPointerEvent<HTMLDivElement>): NormalizedPoint | null => {
    const video = videoRef.current
    if (!video?.videoWidth || !video.videoHeight) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const scale = Math.max(bounds.width / video.videoWidth, bounds.height / video.videoHeight)
    const renderedWidth = video.videoWidth * scale
    const renderedHeight = video.videoHeight * scale
    let x = (event.clientX - bounds.left - (bounds.width - renderedWidth) / 2) / renderedWidth
    if (cameraFacing === 'user') x = 1 - x
    const y = (event.clientY - bounds.top - (bounds.height - renderedHeight) / 2) / renderedHeight
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  }

  const saveDoorRegion = (region: DoorRegion | null) => {
    doorRegionRef.current = region
    setDoorRegion(region)
    const storageKey = `${DOOR_REGION_STORAGE_KEY}:${selectedCameraId || CAMERA_ID}`
    try {
      if (region) localStorage.setItem(storageKey, JSON.stringify(region))
      else localStorage.removeItem(storageKey)
    } catch {
      if (mountedRef.current) setMessage('Doorway calibration is active but could not be saved on this device')
    }
  }

  const handleDoorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCalibratingDoor || state !== 'active') return
    const point = getNormalizedPoint(event)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDoorDragStart(point)
    updateDraftDoorRegion({ left: point.x, top: point.y, right: point.x, bottom: point.y })
  }

  const handleDoorPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!doorDragStart || !isCalibratingDoor) return
    const point = getNormalizedPoint(event)
    if (!point) return
    updateDraftDoorRegion({
      left: Math.min(doorDragStart.x, point.x),
      top: Math.min(doorDragStart.y, point.y),
      right: Math.max(doorDragStart.x, point.x),
      bottom: Math.max(doorDragStart.y, point.y),
    })
  }

  const handleDoorPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!doorDragStart || !isCalibratingDoor) return
    const point = getNormalizedPoint(event)
    if (!point) return
    const region = {
      left: Math.min(doorDragStart.x, point.x),
      top: Math.min(doorDragStart.y, point.y),
      right: Math.max(doorDragStart.x, point.x),
      bottom: Math.max(doorDragStart.y, point.y),
    }
    setDoorDragStart(null)
    updateDraftDoorRegion(null)
    if (region.right - region.left < MIN_DOOR_REGION_SIZE || region.bottom - region.top < MIN_DOOR_REGION_SIZE) {
      setMessage('Doorway calibration cancelled · drag a larger rectangle around the doorway')
      return
    }
    saveDoorRegion(region)
    setIsCalibratingDoor(false)
    tracksRef.current.clear()
    setMessage('Doorway marked · boarding and alighting count only at this doorway')
  }

  const publish = async (status: 'ok' | 'offline') => {
    if (publishInFlightRef.current) return
    publishInFlightRef.current = true
    const observedAt = new Date().toISOString()
    const metrics = confidenceRef.current
    const countsNow = countsRef.current
    const detectedNow = detectedPeopleRef.current
    const totalDetected = totalDetectedPeopleRef.current
    const snapshotSignature = [selectedBusRouteRef.current, totalDetected, countsNow.boarding, countsNow.alighting, countsNow.occupancy].join(':')
    const shouldSaveSnapshot = status === 'offline'
      || Date.now() - lastSnapshotAtRef.current >= 30_000
      || snapshotSignature !== lastSnapshotSignatureRef.current
    let snapshotSaved = true
    try {
      if (sessionIdRef.current && shouldSaveSnapshot) {
        const snapshotId = snapshotIdRef.current ?? crypto.randomUUID()
        snapshotIdRef.current = snapshotId
        const snapshotResponse = await fetch(`${apiUrl}/passenger-count-sessions/${sessionIdRef.current}/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snapshot_id: snapshotId,
            camera_id: CAMERA_ID,
            bus_route: selectedBusRouteRef.current,
            observed_at: observedAt,
            detected_now: detectedNow,
            total_detected: totalDetected,
            boarding_count: countsNow.boarding,
            alighting_count: countsNow.alighting,
            occupancy_count: countsNow.occupancy,
            confidence: metrics.count ? metrics.sum / metrics.count : 0,
            status,
          }),
        })
        if (!snapshotResponse.ok) throw new Error(`Snapshot API returned ${snapshotResponse.status}`)
        snapshotIdRef.current = null
        lastSnapshotAtRef.current = Date.now()
        lastSnapshotSignatureRef.current = snapshotSignature
      }
    } catch {
      snapshotSaved = false
    }
    try {
      const response = await fetch(`${apiUrl}/passenger-counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: CAMERA_ID,
          bus_route: selectedBusRouteRef.current,
          observed_at: observedAt,
          boarding_count: countsNow.boarding,
          alighting_count: countsNow.alighting,
          occupancy_count: countsNow.occupancy,
          confidence: metrics.count ? metrics.sum / metrics.count : 0,
          status,
        }),
      })
      if (!response.ok) throw new Error(`Count API returned ${response.status}`)
      if (mountedRef.current) {
        setMessage(sessionIdRef.current
          ? snapshotSaved ? 'Live detection · history saved to server' : 'Live detection · could not save count history'
          : 'Live detection · latest counts sent; persistent history is not configured')
      }
    } catch {
      if (mountedRef.current) setMessage('Live detection · could not send counts to the API')
    } finally {
      publishInFlightRef.current = false
    }
  }

  const closeSession = async (status: 'completed' | 'interrupted' | 'error') => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    try {
      const response = await fetch(`${apiUrl}/passenger-count-sessions/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ended_at: new Date().toISOString(), status }),
      })
      if (!response.ok) throw new Error(`Session API returned ${response.status}`)
    } catch {
      if (mountedRef.current) setMessage('Live detection · could not close the server session')
    } finally {
      sessionIdRef.current = null
      snapshotIdRef.current = null
    }
  }

  const publishAndCloseSession = async (status: 'completed' | 'interrupted' | 'error') => {
    while (publishInFlightRef.current) await new Promise((resolve) => window.setTimeout(resolve, 50))
    await publish('offline')
    await closeSession(status)
  }

  const stopCamera = async () => {
    runningRef.current = false
    setIsCalibratingDoor(false)
    setDoorDragStart(null)
    updateDraftDoorRegion(null)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    const context = canvasRef.current?.getContext('2d')
    if (context && canvasRef.current) context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    tracksRef.current.clear()
    if (state === 'active') await publishAndCloseSession('completed')
    setDetectedPeople(0)
    setTotalDetectedPeople(0)
    detectedPeopleRef.current = 0
    totalDetectedPeopleRef.current = 0
    setState('idle')
  }

  const switchCamera = async (deviceId: string) => {
    await stopCamera()
    setSelectedCameraId(deviceId)
    await startCamera(deviceId, cameraFacing, true)
  }

  const switchFacing = async () => {
    const nextFacing = cameraFacing === 'environment' ? 'user' : 'environment'
    await stopCamera()
    setCameraFacing(nextFacing)
    setSelectedCameraId('')
    await startCamera('', nextFacing, true)
  }

  const startCamera = async (deviceId = '', facing = cameraFacing, keepCounts = false) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage('Camera access requires a secure page (HTTPS or localhost) and a supported browser')
      setState('error')
      return
    }
    setState('starting')
    setMessage('Requesting camera permission…')
    try {
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } }
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cameras = devices.filter((device) => device.kind === 'videoinput').map((device, index) => ({ id: device.deviceId, label: device.label || `Camera ${index + 1}` }))
      setCameraDevices(cameras)
      const activeTrackSettings = stream.getVideoTracks()[0]?.getSettings()
      const activeCameraId = activeTrackSettings?.deviceId ?? deviceId
      setSelectedCameraId(activeCameraId)
      const savedDoorRegion = readDoorRegion(activeCameraId || CAMERA_ID)
      doorRegionRef.current = savedDoorRegion
      setDoorRegion(savedDoorRegion)
      setIsCalibratingDoor(false)
      setDoorDragStart(null)
      updateDraftDoorRegion(null)
      if (activeTrackSettings?.facingMode === 'user' || activeTrackSettings?.facingMode === 'environment') {
        setCameraFacing(activeTrackSettings.facingMode)
      }
      if (!videoRef.current) throw new Error('Camera preview is not available')
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      if (videoRef.current.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => videoRef.current?.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      }
      setMessage('Loading the local person detector…')
      let model = modelRef.current
      if (!model) {
        if (!modelPromiseRef.current) {
          modelPromiseRef.current = (async () => {
            const tf = await import('@tensorflow/tfjs-core')
            await import('@tensorflow/tfjs-backend-webgl')
            await import('@tensorflow/tfjs-backend-cpu')
            try {
              if (!await tf.setBackend('webgl')) await tf.setBackend('cpu')
            } catch {
              await tf.setBackend('cpu')
            }
            await tf.ready()
            const cocoSsd = await import('@tensorflow-models/coco-ssd')
            const loaded = await cocoSsd.load({ base: 'mobilenet_v2' })
            return { detect: (element: HTMLVideoElement, maxNumBoxes: number, minScore: number) => loaded.detect(element, maxNumBoxes, minScore) as Promise<Detection[]> }
          })()
        }
        model = await modelPromiseRef.current
        modelRef.current = model
      }
      if (!mountedRef.current) {
        streamRef.current?.getTracks().forEach((track) => track.stop())
        return
      }
      if (!keepCounts) countsRef.current = { boarding: 0, alighting: 0, occupancy: Math.max(0, Math.floor(initialOccupancy)) }
      setDetectedPeople(0)
      setTotalDetectedPeople(0)
      detectedPeopleRef.current = 0
      totalDetectedPeopleRef.current = 0
      sessionIdRef.current = null
      snapshotIdRef.current = null
      lastSnapshotAtRef.current = 0
      lastSnapshotSignatureRef.current = ''
      setCounts(countsRef.current)
      tracksRef.current = new Map()
      nextTrackIdRef.current = 1
      lastCrossingAtRef.current = 0
      frameRef.current = 0
      confidenceRef.current = { sum: 0, count: 0 }
      runningRef.current = true
      setState('active')
      const sessionId = crypto.randomUUID()
      try {
        const sessionResponse = await fetch(`${apiUrl}/passenger-count-sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            camera_id: CAMERA_ID,
            bus_route: selectedBusRouteRef.current,
            started_at: new Date().toISOString(),
          }),
        })
        if (!sessionResponse.ok) throw new Error(`Session API returned ${sessionResponse.status}`)
        sessionIdRef.current = sessionId
      } catch {
        setMessage('Live detection · persistent history unavailable; latest counts will still be sent')
      }
      await publish('ok')

      if (canvasRef.current) {
        canvasRef.current.width = videoRef.current?.videoWidth ?? 0
        canvasRef.current.height = videoRef.current?.videoHeight ?? 0
      }

      const detect = async () => {
        const video = videoRef.current
        if (!runningRef.current || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
        try {
          const detections = await model.detect(video, MAX_DETECTIONS_PER_FRAME, confidenceThreshold)
          const now = performance.now()
          const frame = ++frameRef.current
          const canvas = canvasRef.current
          const context = canvas?.getContext('2d')
          const width = canvas?.width || video.videoWidth
          const height = canvas?.height || video.videoHeight
          const axisLength = orientation === 'horizontal' ? height : width
          const line = axisLength * linePosition / 100
          const padding = Math.max(14, axisLength * 0.035)
          const result = trackPeople(detections, tracksRef.current, nextTrackIdRef.current, {
            now, orientation, width, height, linePosition, confidenceThreshold, enteringDirection,
            doorRegion: doorRegionRef.current,
            requireDoorRegion: true,
          })
          const people = result.people
          detectedPeopleRef.current = people.length
          setDetectedPeople((current) => current === people.length ? current : people.length)
          const newTracks = result.nextTrackId - nextTrackIdRef.current
          if (newTracks > 0) {
            totalDetectedPeopleRef.current += newTracks
            setTotalDetectedPeople(totalDetectedPeopleRef.current)
          }
          const nextCounts = {
            boarding: countsRef.current.boarding + result.boarding,
            alighting: countsRef.current.alighting + result.alighting,
            occupancy: Math.max(0, countsRef.current.occupancy + result.boarding - result.alighting),
          }
          tracksRef.current = result.tracks
          nextTrackIdRef.current = result.nextTrackId
          confidenceRef.current.sum += result.confidenceSum
          confidenceRef.current.count += result.confidenceCount
          if (result.lastCrossingAt !== null) lastCrossingAtRef.current = result.lastCrossingAt

          if (context && canvas) {
            context.clearRect(0, 0, width, height)
            const lineColor = now - lastCrossingAtRef.current < 600 ? '#41f0b1' : '#18c6d7'
            context.fillStyle = 'rgba(5, 15, 22, 0.13)'
            if (orientation === 'horizontal') context.fillRect(0, Math.max(0, line - padding), width, Math.min(padding * 2, height))
            else context.fillRect(Math.max(0, line - padding), 0, Math.min(padding * 2, width), height)
            context.setLineDash([10, 8])
            context.strokeStyle = 'rgba(144, 171, 185, .65)'
            context.lineWidth = 2
            context.beginPath()
            if (orientation === 'horizontal') {
              context.moveTo(0, line - padding); context.lineTo(width, line - padding)
              context.moveTo(0, line + padding); context.lineTo(width, line + padding)
            } else {
              context.moveTo(line - padding, 0); context.lineTo(line - padding, height)
              context.moveTo(line + padding, 0); context.lineTo(line + padding, height)
            }
            context.stroke()
            context.setLineDash([])
            context.strokeStyle = lineColor
            context.lineWidth = Math.max(3, width / 420)
            context.beginPath()
            if (orientation === 'horizontal') { context.moveTo(0, line); context.lineTo(width, line) }
            else { context.moveTo(line, 0); context.lineTo(line, height) }
            context.stroke()
            const activeDoorRegion = draftDoorRegionRef.current ?? doorRegionRef.current
            if (activeDoorRegion) {
              context.fillStyle = 'rgba(255, 193, 7, .12)'
              context.fillRect(
                activeDoorRegion.left * width,
                activeDoorRegion.top * height,
                (activeDoorRegion.right - activeDoorRegion.left) * width,
                (activeDoorRegion.bottom - activeDoorRegion.top) * height,
              )
              context.strokeStyle = '#ffc857'
              context.lineWidth = Math.max(2, width / 480)
              context.setLineDash([8, 5])
              context.strokeRect(
                activeDoorRegion.left * width,
                activeDoorRegion.top * height,
                (activeDoorRegion.right - activeDoorRegion.left) * width,
                (activeDoorRegion.bottom - activeDoorRegion.top) * height,
              )
              context.setLineDash([])
            }
            for (const detection of people) {
              const [x, y, boxWidth, boxHeight] = detection.bbox
              const label = `PERSON #${detection.trackId ?? '—'}  ${Math.round(detection.score * 100)}%`
              context.strokeStyle = '#40e8b0'
              context.lineWidth = Math.max(2, width / 640)
              context.strokeRect(x, y, boxWidth, boxHeight)
              context.font = `600 ${Math.max(13, width / 82)}px sans-serif`
              const labelWidth = context.measureText(label).width
              const labelY = Math.max(0, y - 27)
              context.fillStyle = '#40e8b0'
              context.fillRect(x, labelY, labelWidth + 16, 26)
              context.fillStyle = '#071016'
              context.textAlign = 'left'
              context.fillText(label, x + 8, Math.max(18, y - 9))
            }
          }

          if (nextCounts.boarding !== countsRef.current.boarding || nextCounts.alighting !== countsRef.current.alighting || nextCounts.occupancy !== countsRef.current.occupancy) {
            countsRef.current = nextCounts
            setCounts(nextCounts)
          }
          if (frame % 7 === 0) void publish('ok')
        } catch {
          if (mountedRef.current) setMessage('Person detection failed; check browser support and reload the page')
        }
        if (runningRef.current) timerRef.current = window.setTimeout(detect, 300)
      }
      void detect()
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (mountedRef.current) {
        setState('error')
        setMessage(error instanceof Error ? error.message : 'Could not start the camera')
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (stateRef.current === 'active') void publishAndCloseSession('interrupted')
    }
  }, [])

  useEffect(() => {
    if (previousBusRouteRef.current !== selectedBusRoute && state === 'active') {
      countsRef.current = { boarding: 0, alighting: 0, occupancy: Math.max(0, Math.floor(initialOccupancy)) }
      tracksRef.current = new Map()
      setDetectedPeople(0)
      setCounts(countsRef.current)
      void publish('ok')
    }
    previousBusRouteRef.current = selectedBusRoute
  }, [selectedBusRoute, state, initialOccupancy])

  return (
    <div className="live-camera">
      <div className="live-camera-heading">
        <div><strong>Live webcam · local COCO-SSD detection</strong><span>Mark the doorway before passenger crossing counts are enabled</span></div>
        <label>Bus route for doorway counts <select aria-label="Bus for crowd estimate" value={selectedBusRoute} onChange={(event) => onBusChange(event.target.value)}>{buses.map((bus) => <option key={bus.route} value={bus.route}>{bus.route} · {bus.destination}</option>)}</select></label>
        <label>Camera <select aria-label="Select camera device" value={selectedCameraId} disabled={state === 'starting' || cameraDevices.length === 0} onChange={(event) => void switchCamera(event.target.value)}>{cameraDevices.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}</select></label>
        <button type="button" className="camera-facing-toggle" disabled={state === 'starting' || cameraDevices.length === 1} onClick={() => state === 'active' ? void switchFacing() : setCameraFacing(cameraFacing === 'environment' ? 'user' : 'environment')}>{cameraFacing === 'environment' ? 'Switch to front camera' : 'Switch to back camera'}</button>
        <label>Line orientation <select aria-label="Counting line orientation" value={orientation} disabled={state === 'active' || state === 'starting'} onChange={(event) => { const value = event.target.value as Orientation; setOrientation(value); setEnteringDirection(value === 'horizontal' ? 'up' : 'left') }}><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select></label>
        <label>Enters moving <select aria-label="Entering direction" value={enteringDirection} disabled={state === 'active' || state === 'starting'} onChange={(event) => setEnteringDirection(event.target.value as Direction)}>{orientation === 'horizontal' ? <><option value="up">Up</option><option value="down">Down</option></> : <><option value="left">Left</option><option value="right">Right</option></>}</select></label>
        <label>Line position <input aria-label="Counting line position" type="range" min="10" max="90" step="1" value={linePosition} disabled={state === 'active' || state === 'starting'} onChange={(event) => setLinePosition(Number(event.target.value))} /><span>{linePosition}%</span></label>
        <label>Confidence <input aria-label="Detection confidence" type="range" min="20" max="90" step="5" value={Math.round(confidenceThreshold * 100)} disabled={state === 'active' || state === 'starting'} onChange={(event) => setConfidenceThreshold(Number(event.target.value) / 100)} /><span>{Math.round(confidenceThreshold * 100)}%</span></label>
        <label>Starting occupancy <input aria-label="Starting occupancy" type="number" min="0" step="1" value={initialOccupancy} disabled={state === 'active' || state === 'starting'} onChange={(event) => setInitialOccupancy(Math.max(0, Number(event.target.value) || 0))} /></label>
      </div>
      <div className="door-calibration-controls">
        <button type="button" disabled={state !== 'active'} onClick={() => {
          setIsCalibratingDoor((current) => !current)
          setDoorDragStart(null)
          updateDraftDoorRegion(null)
        }}>{isCalibratingDoor ? 'Cancel doorway marking' : doorRegion ? 'Adjust doorway area' : 'Mark doorway area'}</button>
        <button type="button" disabled={!doorRegion} onClick={() => {
          saveDoorRegion(null)
          tracksRef.current.clear()
          setIsCalibratingDoor(false)
          setMessage('Doorway cleared · boarding and alighting counts are paused until it is marked again')
        }}>Clear doorway</button>
        <span role="status">{isCalibratingDoor
          ? 'Drag a rectangle around the doorway that includes the counting line.'
          : doorRegion
            ? 'Doorway marked · only crossings inside the outlined area count.'
            : 'Doorway not marked · boarding and alighting counts are paused.'}</span>
      </div>
      <div
        className={`live-video-wrap${isCalibratingDoor ? ' live-video-calibrating' : ''}`}
        onPointerDown={handleDoorPointerDown}
        onPointerMove={handleDoorPointerMove}
        onPointerUp={handleDoorPointerUp}
        onPointerCancel={() => { setDoorDragStart(null); updateDraftDoorRegion(null) }}
      >
        <video ref={videoRef} className={cameraFacing === 'user' ? 'live-video-mirrored' : undefined} autoPlay muted playsInline aria-label="Live webcam preview" />
        <canvas ref={canvasRef} className={cameraFacing === 'user' ? 'live-video-overlay live-video-mirrored' : 'live-video-overlay'} aria-hidden="true" />
        {state !== 'active' && <div className="live-video-empty">{state === 'starting' ? 'Starting camera and COCO-SSD detector…' : 'Camera is off'}</div>}
        {isCalibratingDoor && <div className="door-calibration-hint" aria-hidden="true">Drag to mark the doorway</div>}
      </div>
      <div className="live-camera-controls">
        <div className="live-local-counts"><span>Detected now <strong>{state === 'active' ? detectedPeople : '—'}</strong></span><span>Total detected <strong>{totalDetectedPeople}</strong></span><span>Boarding <strong>{counts.boarding}</strong></span><span>Alighting <strong>{counts.alighting}</strong></span><span>Occupancy <strong>{counts.occupancy}</strong></span></div>
        <button type="button" disabled={state === 'starting'} onClick={() => void (state === 'active' ? stopCamera() : startCamera())}>{state === 'active' ? 'Stop webcam' : state === 'starting' ? 'Starting…' : 'Start webcam'}</button>
      </div>
      <small className="live-camera-message" role="status">{message || 'Total detected counts new tracking IDs during this camera run; tracking is approximate and may count the same person again if their track is lost. No video is sent to the API; only aggregate counts are published.'}</small>
      {cameraDevices.length === 1 && <small className="live-camera-privacy">Only one camera is available on this device; front/back switching is not supported.</small>}
      <small className="live-camera-privacy">Boarding/alighting count only when tracked people cross the configured line inside the marked doorway area. If the area is not marked, crossing counts stay paused. This is an estimate, not people waiting at the stop or a verified unique-person count. Camera video stays in this browser; stop the camera when finished.</small>
    </div>
  )
}
