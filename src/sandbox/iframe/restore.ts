interface PropertySnapshotTarget {
  target: object
  keys?: PropertyKey[]
}

interface PropertySnapshot {
  target: object
  descriptors: Map<PropertyKey, PropertyDescriptor | undefined>
  removeAddedProperties: boolean
}

/**
 * Capture iframe-owned prototypes before micro-app patches them. Chrome may
 * retain iframe constructors through native handles after the iframe element
 * is removed, so patched prototype closures must not keep the sandbox alive.
 */
export function createIframePropertyRestore (
  targets: PropertySnapshotTarget[],
): () => void {
  const snapshots: PropertySnapshot[] = targets.map(({ target, keys }) => {
    const propertyKeys = keys || Reflect.ownKeys(target)
    return {
      target,
      descriptors: new Map(propertyKeys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(target, key),
      ])),
      removeAddedProperties: !keys,
    }
  })
  let restored = false

  return (): void => {
    if (restored) return
    restored = true

    snapshots.forEach(({ target, descriptors, removeAddedProperties }) => {
      if (removeAddedProperties) {
        Reflect.ownKeys(target).forEach((key) => {
          if (!descriptors.has(key)) Reflect.deleteProperty(target, key)
        })
      }

      descriptors.forEach((descriptor, key) => {
        try {
          if (descriptor) {
            Reflect.defineProperty(target, key, descriptor)
          } else {
            Reflect.deleteProperty(target, key)
          }
        } catch (_) {
          // The iframe may already be tearing down or a polyfill may have made
          // a property non-configurable. Continue restoring the other keys.
        }
      })
      descriptors.clear()
    })
    snapshots.splice(0)
  }
}
