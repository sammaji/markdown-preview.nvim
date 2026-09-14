// Scrolls the preview so the rendered cursor line lines up with where the
// cursor is in the editor window.

export interface CursorPosition {
  /** 1-based cursor line */
  cursor: number;
  /** screen line of the cursor within the window, from `winline()` */
  winline: number;
  winheight: number;
  /** number of lines in the buffer */
  len: number;
}

function lineElement(line: number) {
  return document.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
}

function pageTop(element: HTMLElement) {
  return element.getBoundingClientRect().top + window.scrollY;
}

function scrollTo(top: number) {
  window.scrollTo({ top, behavior: "smooth" });
}

// Offset of a source line; lines without an element of their own are
// interpolated between the closest tagged lines around them.
function lineOffset(line: number, len: number) {
  const exact = lineElement(line);
  if (exact) return pageTop(exact);

  let prev = line - 1;
  let prevElement: HTMLElement | null = null;
  while (prev > 0 && !(prevElement = lineElement(prev))) prev--;
  let next = line + 1;
  let nextElement: HTMLElement | null = null;
  while (next < len && !(nextElement = lineElement(next))) next++;

  const prevTop = prevElement ? pageTop(prevElement) : 0;
  const nextTop = nextElement ? pageTop(nextElement) : document.documentElement.scrollHeight;
  prev = Math.max(prev, 0);
  next = Math.min(next, len - 1);
  return next === prev ? prevTop : prevTop + ((nextTop - prevTop) * (line - prev)) / (next - prev);
}

function scrollToLine(line: number, ratio: number, len: number) {
  if (line <= 0) {
    scrollTo(0);
  } else if (line >= len - 1) {
    scrollTo(document.documentElement.scrollHeight);
  } else {
    scrollTo(lineOffset(line, len) - document.documentElement.clientHeight * ratio);
  }
}

export const syncScroll = {
  /** keep the cursor line at the same relative height as in the editor */
  relative({ cursor, winline, winheight, len }: CursorPosition) {
    scrollToLine(cursor - 1, winline / winheight, len);
  },
  /** keep the cursor line in the middle of the page */
  middle({ cursor, len }: CursorPosition) {
    scrollToLine(cursor - 1, 0.5, len);
  },
  /** keep the top line of the editor window at the top of the page */
  top({ cursor, winline, len }: CursorPosition) {
    const line = cursor - 1;
    scrollToLine(line <= 0 || line >= len - 1 ? line : cursor - winline, 0, len);
  },
};
