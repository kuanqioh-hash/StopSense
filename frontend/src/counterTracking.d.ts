export type Point = { x: number; y: number }
export type CounterTrack = {
  id: number
  frames: number
  side: 'before' | 'after' | null
  anchor: number
  center: Point
  velocity?: Point
  bbox: [number, number, number, number]
  confidence: number
  lastSeen: number
  lastCountAt: number
}
export type CounterDetection = {
  class: string
  score: number
  bbox: [number, number, number, number]
  trackId?: number
}
export type DoorRegion = { left: number; top: number; right: number; bottom: number }
export type TrackingOptions = {
  now: number
  orientation: 'horizontal' | 'vertical'
  width: number
  height: number
  linePosition: number
  confidenceThreshold: number
  enteringDirection: 'up' | 'down' | 'left' | 'right'
  doorRegion?: DoorRegion | null
  requireDoorRegion?: boolean
}
export function trackPeople(
  detections: CounterDetection[],
  tracks: Map<number, CounterTrack>,
  nextTrackId: number,
  options: TrackingOptions,
): {
  people: CounterDetection[]
  tracks: Map<number, CounterTrack>
  nextTrackId: number
  boarding: number
  alighting: number
  confidenceSum: number
  confidenceCount: number
  lastCrossingAt: number | null
}
