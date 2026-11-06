import { createPrefix, hasScopedPrefix } from '../../sandbox/scoped_css'

describe('scoped css dynamic application names', () => {
  test('treats a hyphenated component app name as literal selector text', () => {
    const prefix = createPrefix('WS-Component-TypeRenderMenu-1789459802368')
    const cssText = `${prefix} .menu-item{color: red;}`

    expect(hasScopedPrefix(cssText, prefix)).toBe(true)
    expect(() => new RegExp(prefix)).toThrow(SyntaxError)
  })
})
