import { createRunScriptElement } from '../../source/scripts'
import IframeSandbox from '../../sandbox/iframe'

describe('iframe module script realm', () => {
  test('creates framework-owned scripts in the iframe document', () => {
    const iframeDocument = document.implementation.createHTMLDocument('child')
    const sandbox = Object.create(IframeSandbox.prototype) as any
    sandbox.microAppWindow = { document: iframeDocument }
    sandbox.rawMicroCreateElement = iframeDocument.createElement
    const createSandboxScriptElement = jest.spyOn(sandbox, 'createSandboxScriptElement')
    const app = {
      iframe: true,
      sandBox: sandbox,
    } as any

    const script = createRunScriptElement(app)

    expect(createSandboxScriptElement).toHaveBeenCalledTimes(1)
    expect(script.ownerDocument).toBe(iframeDocument)
    expect(script.__PURE_ELEMENT__).toBe(true)
  })

  test('keeps the base-document path for non-iframe applications', () => {
    const createSandboxScriptElement = jest.fn()
    const app = {
      iframe: false,
      sandBox: { createSandboxScriptElement },
    } as any

    const script = createRunScriptElement(app)

    expect(createSandboxScriptElement).not.toHaveBeenCalled()
    expect(script.ownerDocument).toBe(document)
  })
})
