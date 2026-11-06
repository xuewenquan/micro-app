import {
  addScopedCSSObserver,
  releaseScopedCSSObservers,
} from '../../sandbox/scoped_css_observers'

describe('scoped css observer disposal', () => {
  test('disconnects pending style observers when an app is destroyed', () => {
    const observer = { disconnect: jest.fn() } as unknown as MutationObserver
    addScopedCSSObserver('observer-test-app', observer)

    releaseScopedCSSObservers('observer-test-app')
    expect(observer.disconnect).toHaveBeenCalledTimes(1)

    // The registry entry is removed together with the observers.
    releaseScopedCSSObservers('observer-test-app')
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })
})
