import { describe, expect, it } from 'vitest'
import { resizedSize } from './useResizableDialog'
import { splitRatioAt } from './useSplitRatio'

const viewport = { width: 1600, height: 1000 }
const min = { width: 640, height: 420 }
const center = { x: 800, y: 500 }
const start = { width: 900, height: 600 }

describe('resizedSize', () => {
  it('grows by twice the drag (the dialog is centered) on the dragged axis only', () => {
    expect(resizedSize('e', start, { x: 50, y: 80 }, center, viewport, min)).toEqual({ width: 1000, height: 600 })
    expect(resizedSize('s', start, { x: 50, y: 30 }, center, viewport, min)).toEqual({ width: 900, height: 660 })
    expect(resizedSize('se', start, { x: 50, y: 30 }, center, viewport, min)).toEqual({ width: 1000, height: 660 })
  })

  it('grows when dragging the left or top edge outwards', () => {
    expect(resizedSize('w', start, { x: -50, y: 0 }, center, viewport, min)).toEqual({ width: 1000, height: 600 })
    expect(resizedSize('nw', start, { x: -50, y: -20 }, center, viewport, min)).toEqual({ width: 1000, height: 640 })
  })

  it('never goes past the screen, measured from where the dialog is', () => {
    expect(resizedSize('se', start, { x: 5000, y: 5000 }, center, viewport, min)).toEqual({ width: 1568, height: 968 })
    // Arrastado pra perto da borda esquerda: só cresce até essa borda.
    expect(resizedSize('e', start, { x: 5000, y: 0 }, { x: 516, y: 500 }, viewport, min).width).toBe(1000)
  })

  it('never shrinks below the minimum', () => {
    expect(resizedSize('se', start, { x: -5000, y: -5000 }, center, viewport, min)).toEqual(min)
  })
})

describe('splitRatioAt', () => {
  it('follows the cursor', () => {
    expect(splitRatioAt(400, 0, 1000)).toBe(0.4)
  })

  it('keeps a minimum width for each panel', () => {
    expect(splitRatioAt(10, 0, 1000)).toBe(0.3)
    expect(splitRatioAt(990, 0, 1000)).toBe(0.64)
  })

  it('splits by the minimums when the container is narrower than both', () => {
    const ratio = splitRatioAt(10, 0, 330)
    expect(ratio * 330).toBeCloseTo(150)
  })
})
