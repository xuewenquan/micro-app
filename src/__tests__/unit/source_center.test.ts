import type { LinkSourceInfo, ScriptSourceInfo } from '@micro-app/types'
import sourceCenter from '../../source/source_center'

describe('sourceCenter app disposal', () => {
  const linkAddress = 'https://test.example/shared.css'
  const scriptAddress = 'https://test.example/shared.js'

  afterEach(() => {
    sourceCenter.link.deleteInfo(linkAddress)
    sourceCenter.script.deleteInfo(scriptAddress)
  })

  test('releases only the destroyed app while a source is shared', () => {
    const linkInfo: LinkSourceInfo = {
      code: 'body {}',
      appSpace: {
        app1: { attrs: new Map(), placeholder: document.createComment('app1') },
        app2: { attrs: new Map(), placeholder: document.createComment('app2') },
      },
    }
    const scriptInfo: ScriptSourceInfo = {
      code: 'window.value = 1',
      isExternal: true,
      appSpace: {
        app1: {
          async: false,
          defer: false,
          module: false,
          inline: false,
          pure: false,
          attrs: new Map(),
          parsedFunction: function fromApp1 () {},
        },
        app2: {
          async: false,
          defer: false,
          module: false,
          inline: false,
          pure: false,
          attrs: new Map(),
          parsedFunction: function fromApp2 () {},
        },
      },
    }

    sourceCenter.link.setInfo(linkAddress, linkInfo)
    sourceCenter.script.setInfo(scriptAddress, scriptInfo)
    sourceCenter.releaseApp('app1')

    expect(linkInfo.appSpace.app1).toBeUndefined()
    expect(scriptInfo.appSpace.app1).toBeUndefined()
    expect(sourceCenter.link.getInfo(linkAddress)).toBe(linkInfo)
    expect(sourceCenter.script.getInfo(scriptAddress)).toBe(scriptInfo)
    expect(linkInfo.appSpace.app2).toBeDefined()
    expect(scriptInfo.appSpace.app2).toBeDefined()
  })

  test('evicts a source after its last app is destroyed', () => {
    sourceCenter.link.setInfo(linkAddress, {
      code: '',
      appSpace: { app1: { attrs: new Map() } },
    })
    sourceCenter.script.setInfo(scriptAddress, {
      code: '',
      isExternal: true,
      appSpace: {
        app1: {
          async: false,
          defer: false,
          module: false,
          inline: false,
          pure: false,
          attrs: new Map(),
        },
      },
    })

    sourceCenter.releaseApp('app1')

    expect(sourceCenter.link.hasInfo(linkAddress)).toBe(false)
    expect(sourceCenter.script.hasInfo(scriptAddress)).toBe(false)
  })

  test('drops an old iframe compiled function without losing remount metadata', () => {
    const info: ScriptSourceInfo = {
      code: 'window.value = 1',
      isExternal: true,
      appSpace: {
        app1: {
          async: false, defer: false, module: false, inline: false, pure: false,
          attrs: new Map(), parsedCode: 'wrapped code', parsedFunction: jest.fn(),
        },
      },
    }
    sourceCenter.script.setInfo(scriptAddress, info)
    sourceCenter.releaseAppRealm('app1')
    expect(info.appSpace.app1.parsedFunction).toBeUndefined()
    expect(info.appSpace.app1.parsedCode).toBe('wrapped code')
    expect(sourceCenter.script.getInfo(scriptAddress)?.code).toBe('window.value = 1')
  })
})
