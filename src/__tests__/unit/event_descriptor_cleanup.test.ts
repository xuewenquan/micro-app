jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import dispatchLifecyclesEvent from '../../interact/lifecycles_event'
import { dispatchOnLoadEvent } from '../../source/load_event'

describe('synthetic event descriptors', () => {
  test('lifecycle events do not capture their target through getter closures', () => {
    const container = document.createElement('div')
    let lifecycleEvent: Event | undefined
    container.addEventListener('mounted', (event) => { lifecycleEvent = event })

    dispatchLifecyclesEvent(container, 'event-descriptor-test', 'mounted')

    expect(lifecycleEvent?.target).toBe(container)
    expect(lifecycleEvent?.currentTarget).toBe(container)
    expect(Object.getOwnPropertyDescriptor(lifecycleEvent, 'target')?.get).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(lifecycleEvent, 'currentTarget')?.get).toBeUndefined()
  })

  test('load events do not capture their source through getter closures', () => {
    const link = document.createElement('link')
    let loadEvent: Event | undefined
    link.onload = (event) => { loadEvent = event }

    dispatchOnLoadEvent(link)

    expect(loadEvent?.target).toBe(link)
    expect(loadEvent?.currentTarget).toBe(link)
    expect(loadEvent?.srcElement).toBe(link)
    expect(Object.getOwnPropertyDescriptor(loadEvent, 'target')?.get).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(loadEvent, 'currentTarget')?.get).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(loadEvent, 'srcElement')?.get).toBeUndefined()
  })
})
