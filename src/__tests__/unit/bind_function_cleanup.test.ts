import bindFunctionToRawTarget from '../../sandbox/bind_function'

describe('bindFunctionToRawTarget cache', () => {
  test('uses weak external bookkeeping instead of writing cache keys to source functions', () => {
    const targetA = { value: 'a' }
    const targetB = { value: 'b' }
    function readValue (this: typeof targetA) {
      return this.value
    }

    const boundA = bindFunctionToRawTarget<typeof targetA, () => string>(readValue, targetA)
    const sameBoundA = bindFunctionToRawTarget<typeof targetA, () => string>(readValue, targetA)
    const boundB = bindFunctionToRawTarget<typeof targetB, () => string>(readValue, targetB)

    expect(boundA).toBe(sameBoundA)
    expect(boundB).not.toBe(boundA)
    expect(boundA()).toBe('a')
    expect(boundB()).toBe('b')
    expect(Reflect.ownKeys(readValue).some((key) => String(key).startsWith('__MICRO_APP_'))).toBe(false)
  })
})
