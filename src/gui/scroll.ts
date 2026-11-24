/** How close to the bottom, in pixels, still counts as following the transcript. */
export const FOLLOW_THRESHOLD = 32

interface Scrollable {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Whether the list is scrolled to (or within a few pixels of) its end. The panel only keeps following new transcript
 * text while this holds, so scrolling up to read earlier lines is not undone by the next delta.
 */
export function atBottom(element: Scrollable, threshold = FOLLOW_THRESHOLD) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
