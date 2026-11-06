interface CallbackCell {
  callback: Function | null
}

// Deliberately outside createPolicy's scope: a document-lifetime native policy
// must capture only this releasable cell, never the child's options or window.
function wrapCallback (cell: CallbackCell): Function {
  return function (this: unknown, ...args: unknown[]): unknown {
    if (!cell.callback) throw new TypeError('[micro-app] Trusted Types policy owner was destroyed')
    return Reflect.apply(cell.callback, this, args)
  }
}

interface TrustedTypesScope {
  wrap: (factory: any) => any
  dispose: () => void
}

export function createTrustedTypesScope (): TrustedTypesScope {
  const cells = new Set<CallbackCell>()
  const factories = new WeakMap<object, object>()
  let disposed = false
  return {
    wrap (factory: any): any {
      if (!factory || typeof factory.createPolicy !== 'function') return factory
      const cached = factories.get(factory)
      if (cached) return cached
      const createPolicy = (name: string, options: any): unknown => {
        if (disposed) throw new TypeError('[micro-app] Trusted Types policy owner was destroyed')
        const owned: CallbackCell[] = []
        const forwarded: Record<string, unknown> = {}
        // Read each WebIDL callback once. Preserve caller validation rather
        // than replacing sanitizers with an identity/allow-all callback.
        try {
          for (const key of ['createHTML', 'createScript', 'createScriptURL']) {
            const callback = options?.[key]
            if (typeof callback === 'function') {
              const cell = { callback }
              owned.push(cell)
              cells.add(cell)
              forwarded[key] = wrapCallback(cell)
            } else if (callback !== undefined) {
              forwarded[key] = callback
            }
          }
          if (disposed) throw new TypeError('[micro-app] Trusted Types policy owner was destroyed')
          return factory.createPolicy(name, forwarded)
        } catch (error) {
          owned.forEach((cell) => { cell.callback = null; cells.delete(cell) })
          throw error
        }
      }
      const proxy = new Proxy(factory, {
        get (target, key): unknown {
          if (key === 'createPolicy') return createPolicy
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      factories.set(factory, proxy)
      return proxy
    },
    dispose (): void {
      disposed = true
      cells.forEach((cell) => { cell.callback = null })
      cells.clear()
    },
  }
}
