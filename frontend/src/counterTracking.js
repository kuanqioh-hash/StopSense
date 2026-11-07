const TRACK_MATCH_DISTANCE = 0.2
const TRACK_STALE_MS = 2000
const TRACK_COOLDOWN_MS = 3500

export function trackPeople(detections, tracks, nextTrackId, options) {
  const { now, orientation, width, height, linePosition, confidenceThreshold, enteringDirection } = options
  const axisLength = orientation === 'horizontal' ? height : width
  const line = axisLength * linePosition / 100
  const padding = Math.max(14, axisLength * 0.035)
  const crossingDistance = Math.max(30, axisLength * 0.11)
  const matchDistance = Math.max(45, Math.min(width, height) * TRACK_MATCH_DISTANCE)
  const people = detections
    .filter((item) => item.class === 'person' && item.score >= confidenceThreshold)
    .sort((a, b) => b.score - a.score)
  const updatedTracks = new Map(tracks)
  const candidateMatches = []
  for (let detectionIndex = 0; detectionIndex < people.length; detectionIndex += 1) {
    const [x, y, boxWidth, boxHeight] = people[detectionIndex].bbox
    const center = { x: x + boxWidth / 2, y: y + boxHeight / 2 }
    for (const track of tracks.values()) {
      if (now - track.lastSeen > 700) continue
      const elapsed = now - track.lastSeen
      const velocity = track.velocity ?? { x: 0, y: 0 }
      const predictedCenter = {
        x: track.center.x + velocity.x * elapsed,
        y: track.center.y + velocity.y * elapsed,
      }
      const distance = Math.hypot(center.x - predictedCenter.x, center.y - predictedCenter.y)
      if (distance < matchDistance) candidateMatches.push({ detectionIndex, trackId: track.id, distance })
    }
  }
  candidateMatches.sort((a, b) => a.distance - b.distance)
  const matchedDetections = new Map()
  const matchedTracks = new Set()
  for (const candidate of candidateMatches) {
    if (matchedDetections.has(candidate.detectionIndex) || matchedTracks.has(candidate.trackId)) continue
    matchedDetections.set(candidate.detectionIndex, candidate.trackId)
    matchedTracks.add(candidate.trackId)
  }
  let boarding = 0
  let alighting = 0
  let confidenceSum = 0
  let confidenceCount = 0
  let lastCrossingAt = null
  const positiveDirectionIsEntry = enteringDirection === 'down' || enteringDirection === 'right'

  for (const [detectionIndex, detection] of people.entries()) {
    const [x, y, boxWidth, boxHeight] = detection.bbox
    const center = { x: x + boxWidth / 2, y: y + boxHeight / 2 }
    const coordinate = orientation === 'horizontal' ? center.y : center.x
    const matchedTrackId = matchedDetections.get(detectionIndex)
    const closest = matchedTrackId === undefined ? undefined : updatedTracks.get(matchedTrackId)
    const track = closest || {
      id: nextTrackId++, frames: 0, side: null, anchor: coordinate,
      center, velocity: { x: 0, y: 0 }, bbox: detection.bbox,
      confidence: detection.score, lastSeen: now, lastCountAt: 0,
    }
    const elapsed = now - track.lastSeen
    if (track.frames > 0 && elapsed > 0) {
      const measuredVelocity = {
        x: (center.x - track.center.x) / elapsed,
        y: (center.y - track.center.y) / elapsed,
      }
      const previousVelocity = track.velocity ?? { x: 0, y: 0 }
      track.velocity = {
        x: previousVelocity.x * 0.35 + measuredVelocity.x * 0.65,
        y: previousVelocity.y * 0.35 + measuredVelocity.y * 0.65,
      }
    }
    track.center = center
    track.bbox = detection.bbox
    track.confidence = detection.score
    track.frames += 1
    track.lastSeen = now

    if (track.side === null) {
      if (coordinate < line - padding) track.side = 'before'
      else if (coordinate > line + padding) track.side = 'after'
      track.anchor = coordinate
    } else {
      const movedEnough = Math.abs(coordinate - track.anchor) >= crossingDistance
      const cooldownDone = !track.lastCountAt || now - track.lastCountAt > TRACK_COOLDOWN_MS
      let crossingDirection = null
      if (track.frames >= 3 && movedEnough && cooldownDone && track.side === 'before' && coordinate > line + padding) {
        crossingDirection = 'forward'
        track.side = 'after'
        track.anchor = coordinate
      } else if (track.frames >= 3 && movedEnough && cooldownDone && track.side === 'after' && coordinate < line - padding) {
        crossingDirection = 'backward'
        track.side = 'before'
        track.anchor = coordinate
      }
      if (crossingDirection) {
        const isBoarding = (crossingDirection === 'forward') === positiveDirectionIsEntry
        if (isBoarding) boarding += 1
        else alighting += 1
        confidenceSum += detection.score
        confidenceCount += 1
        track.lastCountAt = now
        lastCrossingAt = now
      }
    }
    updatedTracks.set(track.id, track)
    detection.trackId = track.id
  }

  for (const [id, track] of updatedTracks) {
    if (now - track.lastSeen > TRACK_STALE_MS) updatedTracks.delete(id)
  }
  return { people, tracks: updatedTracks, nextTrackId, boarding, alighting, confidenceSum, confidenceCount, lastCrossingAt }
}
