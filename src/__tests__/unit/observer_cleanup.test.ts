import { patchMatchMedia, patchObserverConstructors } from '../../sandbox/observer'

class MockMutationObserver {
  public observe = jest.fn()
  public disconnectMock = jest.fn()
  public disconnect = (...args: any[]) => this.disconnectMock(...args)

  constructor (public callback: MutationCallback) {}
}

describe('sandbox observer cleanup', () => {
  test('disconnects observers that are still registered on destroy', () => {
    const sourceWindow = {
      MutationObserver: MockMutationObserver,
    } as unknown as Window
    const microAppWindow = {} as Window
    const release = patchObserverConstructors(microAppWindow, sourceWindow)
    const observer = new (microAppWindow as any).MutationObserver(jest.fn()) as MockMutationObserver

    observer.observe({} as Node)
    release(true)

    expect(observer.disconnectMock).toHaveBeenCalledTimes(1)
    expect(observer).toBeInstanceOf(MockMutationObserver)
  })

  test('does not disconnect observers while preserving sandbox effects', () => {
    const sourceWindow = {
      MutationObserver: MockMutationObserver,
    } as unknown as Window
    const microAppWindow = {} as Window
    const release = patchObserverConstructors(microAppWindow, sourceWindow)
    const observer = new (microAppWindow as any).MutationObserver(jest.fn()) as MockMutationObserver

    observer.observe({} as Node)
    release(false)

    expect(observer.disconnectMock).not.toHaveBeenCalled()
  })

  test('tracks an observer again when observe is called after disconnect', () => {
    const sourceWindow = {
      MutationObserver: MockMutationObserver,
    } as unknown as Window
    const microAppWindow = {} as Window
    const release = patchObserverConstructors(microAppWindow, sourceWindow)
    const observer = new (microAppWindow as any).MutationObserver(jest.fn()) as MockMutationObserver

    observer.disconnect()
    observer.observe({} as Node)
    release(true)

    expect(observer.disconnectMock).toHaveBeenCalledTimes(2)
  })
})

describe('media query listener cleanup', () => {
  test('removes legacy addListener callbacks on terminal release', () => {
    const listener = jest.fn()
    const rawAddListener = jest.fn()
    const rawRemoveListener = jest.fn()
    const mediaQueryList = {
      addListener: rawAddListener,
      removeListener: rawRemoveListener,
    } as unknown as MediaQueryList
    const sourceWindow = {
      matchMedia: jest.fn(() => mediaQueryList),
    } as unknown as Window
    const microAppWindow = {} as any

    const release = patchMatchMedia(microAppWindow, sourceWindow)
    const result = microAppWindow.matchMedia('(min-width: 768px)')
    result.addListener(listener)

    expect(rawAddListener).toHaveBeenCalledWith(listener)
    release(true)
    expect(rawRemoveListener).toHaveBeenCalledWith(listener)
  })

  test('preserves media query listeners while keep-alive app is hidden', () => {
    const listener = jest.fn()
    const rawRemoveListener = jest.fn()
    const mediaQueryList = {
      addListener: jest.fn(),
      removeListener: rawRemoveListener,
    } as unknown as MediaQueryList
    const sourceWindow = {
      matchMedia: jest.fn(() => mediaQueryList),
    } as unknown as Window
    const microAppWindow = {} as any

    const release = patchMatchMedia(microAppWindow, sourceWindow)
    microAppWindow.matchMedia('(min-width: 768px)').addListener(listener)
    release(false)

    expect(rawRemoveListener).not.toHaveBeenCalled()
  })
})
