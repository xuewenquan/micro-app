interface FrameCell {
  callback: FrameRequestCallback | null,
  id: number,
}

interface FrameState {
  cells: Map<number, FrameCell>,
  target: Window,
}

// Deliberately outside the patch scope: native callbacks retain only releasable
// cells, not the registration call's callback or sandbox lexical context.
function frameCallback (state: FrameState, cell: FrameCell): FrameRequestCallback {
  return (time) => {
    state.cells.delete(cell.id)
    const callback = cell.callback
    cell.callback = null
    if (callback) Reflect.apply(callback, state.target, [time])
  }
}

export function patchAnimationFrame (microWindow: Window, target: Window): {
  release: (clear: boolean) => void,
  dispose: () => void,
} {
  const request = target.requestAnimationFrame
  const cancel = target.cancelAnimationFrame
  const state: FrameState = { cells: new Map(), target }
  let disposed = false
  const release = (clear: boolean): void => {
    if (!clear) return
    const pending = Array.from(state.cells.values())
    state.cells.clear()
    // Clear all child callbacks before cancellation, including callbacks which
    // native scheduling may already have dequeued for this frame.
    pending.forEach((cell) => { cell.callback = null })
    pending.forEach((cell) => {
      try { cancel.call(target, cell.id) } catch (_) { /* continue teardown */ }
    })
  }
  if (typeof request === 'function' && typeof cancel === 'function') {
    microWindow.requestAnimationFrame = (callback) => {
      if (disposed) return 0
      if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame callback must be a function')
      const cell: FrameCell = { callback, id: 0 }
      cell.id = request.call(target, frameCallback(state, cell))
      state.cells.set(cell.id, cell)
      return cell.id
    }
    microWindow.cancelAnimationFrame = (id) => {
      const cell = state.cells.get(id)
      if (cell) cell.callback = null
      state.cells.delete(id)
      cancel.call(target, id)
    }
  }
  return {
    release,
    dispose () {
      if (disposed) return
      disposed = true
      release(true)
    },
  }
}
