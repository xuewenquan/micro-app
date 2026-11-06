// Shared factories execute in the base realm: child XMLHttpRequest patches do
// not see their requests. Opt-in factories return an instance with dispose().
// Never infer ownership from a transient currentAppName or sweep base resources.
export const RESOURCE_FACTORY_MARK = '__MICRO_APP_RESOURCE_FACTORY__'

interface ResourceFactoryScope {
  wrap: (value: unknown) => unknown,
  dispose: () => void,
}

export function createResourceFactoryScope (): ResourceFactoryScope {
  let disposed = false
  const resources = new Set<{ dispose:() => void }>()
  const objects = new WeakMap<object, object>()
  const functions = new WeakMap<Function, Function>()
  return {
    wrap (value: unknown): unknown {
      if (!value || typeof value !== 'object') return value
      const object = value as object
      if (!Reflect.ownKeys(object).some((key) => {
        const factory = Reflect.getOwnPropertyDescriptor(object, key)?.value
        return typeof factory === 'function' && factory[RESOURCE_FACTORY_MARK] === true
      })) return value
      let proxy = objects.get(object)
      if (!proxy) {
        proxy = new Proxy(object, {
          get (target, key, receiver) {
            const factory = Reflect.get(target, key, receiver)
            if (typeof factory !== 'function' || factory[RESOURCE_FACTORY_MARK] !== true) return factory
            // Respect Proxy invariants for frozen shared objects.
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
            if (descriptor && !descriptor.configurable && descriptor.writable === false) return factory
            let wrapped = functions.get(factory)
            if (!wrapped) {
              wrapped = function (this: unknown, ...args: unknown[]) {
                if (disposed) throw new Error('Cannot create resources for a destroyed micro-app')
                const resource = Reflect.apply(factory, this, args)
                if (resource && typeof resource.dispose === 'function') {
                  if (disposed) resource.dispose()
                  else resources.add(resource)
                }
                return resource
              }
              functions.set(factory, wrapped)
            }
            return wrapped
          },
        })
        objects.set(object, proxy)
      }
      return proxy
    },
    dispose () {
      if (disposed) return
      disposed = true
      for (const resource of resources) {
        try { resource.dispose() } catch (error) { console.warn(String(error)) }
      }
      resources.clear()
    },
  }
}
