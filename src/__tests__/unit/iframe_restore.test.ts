import { createIframePropertyRestore } from '../../sandbox/iframe/restore'

describe('iframe property restore', () => {
  test('restores replaced descriptors and removes properties added by patches', () => {
    const original = jest.fn()
    const target = { method: original }
    const restore = createIframePropertyRestore([{ target }])

    target.method = jest.fn()
    Object.defineProperty(target, 'patched', {
      configurable: true,
      value: jest.fn(),
    })
    restore()
    restore()

    expect(target.method).toBe(original)
    expect(Reflect.has(target, 'patched')).toBe(false)
  })

  test('restores only selected properties without deleting child properties', () => {
    const target: Record<string, unknown> = { image: 'raw' }
    const restore = createIframePropertyRestore([{ target, keys: ['image'] }])

    target.image = 'proxy'
    target.childValue = true
    restore()

    expect(target.image).toBe('raw')
    expect(target.childValue).toBe(true)
  })

  test('deletes selected properties that did not exist before patching', () => {
    const target: Record<string, unknown> = {}
    const restore = createIframePropertyRestore([{
      target,
      keys: ['mount', 'unmount', 'micro-app-app1'],
    }])

    Object.defineProperties(target, {
      mount: { configurable: true, get: jest.fn() },
      unmount: { configurable: true, get: jest.fn() },
      'micro-app-app1': { configurable: true, get: jest.fn() },
    })
    restore()

    expect(Reflect.has(target, 'mount')).toBe(false)
    expect(Reflect.has(target, 'unmount')).toBe(false)
    expect(Reflect.has(target, 'micro-app-app1')).toBe(false)
  })
})
