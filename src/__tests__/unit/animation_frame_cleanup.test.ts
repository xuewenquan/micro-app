import { patchAnimationFrame } from '../../sandbox/animation_frame'

function host () {
  const callbacks = new Map<number, FrameRequestCallback>()
  let id = 0
  const target = {
    requestAnimationFrame: jest.fn((callback: FrameRequestCallback) => {
      callbacks.set(++id, callback)
      return id
    }),
    cancelAnimationFrame: jest.fn((frame: number) => callbacks.delete(frame)),
  } as unknown as Window
  return { target, callbacks }
}

describe('instance-owned animation frames', () => {
  test('completion forwards timestamp/this and does not retain completed frame IDs', () => {
    const { target, callbacks } = host()
    const child = {} as Window
    const scope = patchAnimationFrame(child, target)
    const callback = jest.fn(function (this: Window, time: number) {
      expect(this).toBe(target)
      expect(time).toBe(42)
    })
    const id = child.requestAnimationFrame(callback)
    callbacks.get(id)!(42)
    scope.dispose()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(target.cancelAnimationFrame).not.toHaveBeenCalled()
  })

  test('keep-alive preserves frames; terminal disposal nulls queued callbacks and rejects cached late submission', () => {
    const { target, callbacks } = host()
    const child = {} as Window
    const scope = patchAnimationFrame(child, target)
    const request = child.requestAnimationFrame
    const callback = jest.fn()
    const id = request(callback)
    const queued = callbacks.get(id)!
    scope.release(false)
    expect(target.cancelAnimationFrame).not.toHaveBeenCalled()
    scope.dispose()
    scope.dispose()
    expect(target.cancelAnimationFrame).toHaveBeenCalledTimes(1)
    queued(42)
    expect(callback).not.toHaveBeenCalled()
    expect(request(callback)).toBe(0)
    expect(target.requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  test('cancellation and scope disposal leave other instances and base frames intact', () => {
    const { target, callbacks } = host()
    const a = {} as Window
    const b = {} as Window
    const sa = patchAnimationFrame(a, target)
    const sb = patchAnimationFrame(b, target)
    const old = jest.fn()
    const current = jest.fn()
    const base = jest.fn()
    const first = a.requestAnimationFrame(old)
    const queued = callbacks.get(first)!
    a.cancelAnimationFrame(first)
    queued(1)
    expect(old).not.toHaveBeenCalled()
    a.requestAnimationFrame(old)
    const second = b.requestAnimationFrame(current)
    const third = target.requestAnimationFrame(base)
    sa.dispose()
    expect(callbacks.has(second)).toBe(true)
    expect(callbacks.has(third)).toBe(true)
    sb.dispose()
    expect(callbacks.has(third)).toBe(true)
  })
})
