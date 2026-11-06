// A pending MutationObserver is a browser GC root. Track scoped-style
// observers by app so terminal destroy can disconnect observers whose styles
// never mutate and whose callbacks would otherwise retain the whole app.
const appStyleObservers = new Map<string, Set<MutationObserver>>()

export function addScopedCSSObserver (appName: string, observer: MutationObserver): void {
  let observers = appStyleObservers.get(appName)
  if (!observers) appStyleObservers.set(appName, observers = new Set())
  observers.add(observer)
}

export function removeScopedCSSObserver (appName: string, observer: MutationObserver): void {
  const observers = appStyleObservers.get(appName)
  if (!observers) return
  observers.delete(observer)
  if (!observers.size) appStyleObservers.delete(appName)
}

export function releaseScopedCSSObservers (appName: string): void {
  const observers = appStyleObservers.get(appName)
  if (!observers) return
  observers.forEach((observer) => observer.disconnect())
  observers.clear()
  appStyleObservers.delete(appName)
}
