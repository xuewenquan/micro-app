import { logError } from './utils'

/** A failed disposal step must not prevent unrelated resources being released. */
export function runCleanupStep (appName: string, label: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    // Do not print the Error object: DevTools can retain its captured contexts
    // and make a destroyed bundle appear alive in subsequent heap snapshots.
    logError(`${label}: ${String(error)}`, appName)
  }
}
