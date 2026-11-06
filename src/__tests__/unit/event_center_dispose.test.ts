import EventCenter from '../../interact/event_center'

describe('EventCenter disposal', () => {
  test('removes callbacks, data and pending dispatch tasks', async () => {
    const callback = jest.fn()
    const nextStep = jest.fn()
    const eventCenter = new EventCenter()

    eventCenter.on('app-event', callback)
    eventCenter.dispatch('app-event', { retained: {} }, nextStep)
    eventCenter.dispose('app-event')

    await Promise.resolve()

    expect(eventCenter.eventList.has('app-event')).toBe(false)
    expect(eventCenter.getData('app-event')).toBeNull()
    expect(callback).not.toBeCalled()
    expect(nextStep).not.toBeCalled()
  })
})
