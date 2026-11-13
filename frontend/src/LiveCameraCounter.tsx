import { useEffect, useRef, useState } from 'react'
import { trackPeople, type CounterDetection as Detection, type CounterTrack as Track } from './counterTracking.js'

type Counts = { boarding: number; alighting: number; occupancy: number }
type Bus = { route: string; destination: string }
type CameraDevice = { id: string; label: string }
type Orientation = 'horizontal' | 'vertical'
type Direction = 'up' | 'down' | 'left' | 'right'

const CAMERA_ID = 'browser-camera-01'
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
  const selectedBusRouteRef = useRef(selectedBusRoute)
  const previousBusRouteRef = useRef(selectedBusRoute)
  selectedBusRouteRef.current = selectedBusRoute
  const [counts, setCounts] = useState<Counts>(countsRef.current)
  const [detectedPeople, setDetectedPeople] = useState(0)
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

  const publish = async (status: 'ok' | 'offline') => {
    const metrics = confidenceRef.current
    try {
      const response = await fetch(`${apiUrl}/passenger-counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: CAMERA_ID,
          bus_route: selectedBusRouteRef.current,
          observed_at: new Date().toISOString(),
          boarding_count: countsRef.current.boarding,
          alighting_count: countsRef.current.alighting,
          occupancy_count: countsRef.current.occupancy,
          confidence: metrics.count ? metrics.sum / metrics.count : 0,
          status,
        }),
      })
      if (!response.ok) throw new Error(`Count API returned ${response.status}`)
      if (mountedRef.current) setMessage('Live detection · counts sent to Operations')
    } catch {
      if (mountedRef.current) setMessage('Live detection · could not send counts to the API')
    }
  }

  const stopCamera = async () => {
    runningRef.current = false
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    const context = canvasRef.current?.getContext('2d')
    if (context && canvasRef.current) context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    tracksRef.current.clear()
    setDetectedPeople(0)
    if (state === 'active') await publish('offline')
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
      setCounts(countsRef.current)
      tracksRef.current = new Map()
      nextTrackIdRef.current = 1
      lastCrossingAtRef.current = 0
      frameRef.current = 0
      confidenceRef.current = { sum: 0, count: 0 }
      runningRef.current = true
      setState('active')
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
          })
          const people = result.people
          setDetectedPeople((current) => current === people.length ? current : people.length)
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
      if (stateRef.current === 'active') void publish('offline')
    }
  }, [])

  useEffect(() => {
    if (previousBusRouteRef.current !== selectedBusRoute && state === 'active') {
      countsRef.current = { boarding: 0, alighting: 0, occupancy: Math.max(0, Math.floor(initialOccupancy)) }
      tracksRef.current = new Map()
      nextTrackIdRef.current = 1
      setCounts(countsRef.current)
      void publish('ok')
    }
    previousBusRouteRef.current = selectedBusRoute
  }, [selectedBusRoute, state, initialOccupancy])

  return (
    <div className="live-camera">
      <div className="live-camera-heading">
        <div><strong>Live webcam · local COCO-SSD detection</strong><span>Camera video stays in this browser</span></div>
        <label>Bus route for doorway counts <select aria-label="Bus for crowd estimate" value={selectedBusRoute} onChange={(event) => onBusChange(event.target.value)}>{buses.map((bus) => <option key={bus.route} value={bus.route}>{bus.route} · {bus.destination}</option>)}</select></label>
        <label>Camera <select aria-label="Select camera device" value={selectedCameraId} disabled={state === 'starting' || cameraDevices.length === 0} onChange={(event) => void switchCamera(event.target.value)}>{cameraDevices.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}</select></label>
        <button type="button" className="camera-facing-toggle" disabled={state === 'starting' || cameraDevices.length === 1} onClick={() => state === 'active' ? void switchFacing() : setCameraFacing(cameraFacing === 'environment' ? 'user' : 'environment')}>{cameraFacing === 'environment' ? 'Switch to front camera' : 'Switch to back camera'}</button>
        <label>Line orientation <select aria-label="Counting line orientation" value={orientation} disabled={state === 'active' || state === 'starting'} onChange={(event) => { const value = event.target.value as Orientation; setOrientation(value); setEnteringDirection(value === 'horizontal' ? 'up' : 'left') }}><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select></label>
        <label>Enters moving <select aria-label="Entering direction" value={enteringDirection} disabled={state === 'active' || state === 'starting'} onChange={(event) => setEnteringDirection(event.target.value as Direction)}>{orientation === 'horizontal' ? <><option value="up">Up</option><option value="down">Down</option></> : <><option value="left">Left</option><option value="right">Right</option></>}</select></label>
        <label>Line position <input aria-label="Counting line position" type="range" min="10" max="90" step="1" value={linePosition} disabled={state === 'active' || state === 'starting'} onChange={(event) => setLinePosition(Number(event.target.value))} /><span>{linePosition}%</span></label>
        <label>Confidence <input aria-label="Detection confidence" type="range" min="20" max="90" step="5" value={Math.round(confidenceThreshold * 100)} disabled={state === 'active' || state === 'starting'} onChange={(event) => setConfidenceThreshold(Number(event.target.value) / 100)} /><span>{Math.round(confidenceThreshold * 100)}%</span></label>
        <label>Starting occupancy <input aria-label="Starting occupancy" type="number" min="0" step="1" value={initialOccupancy} disabled={state === 'active' || state === 'starting'} onChange={(event) => setInitialOccupancy(Math.max(0, Number(event.target.value) || 0))} /></label>
      </div>
      <div className="live-video-wrap">
        <video ref={videoRef} className={cameraFacing === 'user' ? 'live-video-mirrored' : undefined} autoPlay muted playsInline aria-label="Live webcam preview" />
        <canvas ref={canvasRef} className={cameraFacing === 'user' ? 'live-video-overlay live-video-mirrored' : 'live-video-overlay'} aria-hidden="true" />
        {state !== 'active' && <div className="live-video-empty">{state === 'starting' ? 'Starting camera and COCO-SSD detector…' : 'Camera is off'}</div>}
      </div>
      <div className="live-camera-controls">
        <div className="live-local-counts"><span>Detected now <strong>{state === 'active' ? detectedPeople : '—'}</strong></span><span>Boarding <strong>{counts.boarding}</strong></span><span>Alighting <strong>{counts.alighting}</strong></span><span>Occupancy <strong>{counts.occupancy}</strong></span></div>
        <button type="button" disabled={state === 'starting'} onClick={() => void (state === 'active' ? stopCamera() : startCamera())}>{state === 'active' ? 'Stop webcam' : state === 'starting' ? 'Starting…' : 'Start webcam'}</button>
      </div>
      <small className="live-camera-message" role="status">{message || 'No video is sent to the API; only aggregate counts are published.'}</small>
      {cameraDevices.length === 1 && <small className="live-camera-privacy">Only one camera is available on this device; front/back switching is not supported.</small>}
      <small className="live-camera-privacy">These doorway crossings estimate boarding/alighting and onboard occupancy, not people waiting at the stop. Allow camera access when prompted; video stays in this browser. Stop the camera when finished.</small>
    </div>
  )
}
