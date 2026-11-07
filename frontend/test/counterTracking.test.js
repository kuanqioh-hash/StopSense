import assert from 'node:assert/strict'
import test from 'node:test'
import { trackPeople } from '../src/counterTracking.js'

const person = (centerY, score = 0.9, centerX = 120) => ({ class: 'person', score, bbox: [centerX - 20, centerY - 50, 40, 100] })
const options = (now, overrides = {}) => ({
  now,
  orientation: 'horizontal',
  width: 640,
  height: 400,
  linePosition: 55,
  confidenceThreshold: 0.4,
  enteringDirection: 'down',
  ...overrides,
})

function frame(detections, now, tracks = new Map(), nextTrackId = 1, overrides = {}) {
  return trackPeople(detections, tracks, nextTrackId, options(now, overrides))
}

test('tracks people across the line and counts a boarding after three observations', () => {
  let result = frame([person(180)], 0)
  result = frame([person(190)], 100, result.tracks, result.nextTrackId)
  result = frame([person(240)], 200, result.tracks, result.nextTrackId)

  assert.equal(result.boarding, 1)
  assert.equal(result.alighting, 0)
  assert.equal(result.people[0].trackId, 1)
  assert.equal(result.confidenceCount, 1)
})

test('counts multiple people boarding in the same frame', () => {
  const xPositions = [90, 300, 520]
  let result = frame(xPositions.map((x) => person(180, 0.9, x)), 0)
  result = frame(xPositions.map((x) => person(190, 0.9, x)), 100, result.tracks, result.nextTrackId)
  result = frame(xPositions.map((x) => person(240, 0.9, x)), 200, result.tracks, result.nextTrackId)

  assert.equal(result.boarding, 3)
  assert.equal(result.alighting, 0)
  assert.equal(new Set(result.people.map((detection) => detection.trackId)).size, 3)
})

test('counts multiple people alighting in the same frame', () => {
  const xPositions = [90, 300, 520]
  let result = frame(xPositions.map((x) => person(240, 0.9, x)), 0)
  result = frame(xPositions.map((x) => person(230, 0.9, x)), 100, result.tracks, result.nextTrackId)
  result = frame(xPositions.map((x) => person(180, 0.9, x)), 200, result.tracks, result.nextTrackId)

  assert.equal(result.boarding, 0)
  assert.equal(result.alighting, 3)
})

test('keeps opposite-moving people on their tracks as they pass each other', () => {
  let result = frame([person(180), person(260)], 0)
  result = frame([person(210), person(230)], 100, result.tracks, result.nextTrackId)
  result = frame([person(240), person(200)], 200, result.tracks, result.nextTrackId)

  assert.equal(result.boarding, 1)
  assert.equal(result.alighting, 1)
  assert.equal(result.people[0].trackId, 1)
  assert.equal(result.people[1].trackId, 2)
})

test('counts a crowded frame with more than 20 people crossing together', () => {
  const xPositions = Array.from({ length: 25 }, (_, index) => 80 + index * 95)
  let result = frame(xPositions.map((x) => person(180, 0.9, x)), 0, new Map(), 1, { width: 2500 })
  result = frame(xPositions.map((x) => person(190, 0.9, x)), 100, result.tracks, result.nextTrackId, { width: 2500 })
  result = frame(xPositions.map((x) => person(240, 0.9, x)), 200, result.tracks, result.nextTrackId, { width: 2500 })

  assert.equal(result.boarding, 25)
  assert.equal(result.people.length, 25)
  assert.equal(new Set(result.people.map((detection) => detection.trackId)).size, 25)
})

test('applies confidence filtering and configurable crossing direction', () => {
  const lowConfidence = frame([person(180, 0.3)], 0)
  assert.equal(lowConfidence.people.length, 0)
  assert.equal(lowConfidence.tracks.size, 0)

  let result = frame([person(240)], 0, new Map(), 1, { enteringDirection: 'up' })
  result = frame([person(190)], 100, result.tracks, result.nextTrackId, { enteringDirection: 'up' })
  result = frame([person(180)], 200, result.tracks, result.nextTrackId, { enteringDirection: 'up' })

  assert.equal(result.boarding, 1)
  assert.equal(result.alighting, 0)
})
