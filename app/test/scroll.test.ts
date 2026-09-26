import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRenderer } from "@/lib/markdown";
import { syncScroll } from "@/lib/scroll";

const SCROLL_HEIGHT = 3000;
const CLIENT_HEIGHT = 400;
const SCROLL_Y = 120;

let scrollTo: ReturnType<typeof vi.fn>;

// Places elements tagged with data-source-line at fixed page offsets.
function layout(tops: Record<number, number>) {
  document.body.innerHTML = "";
  for (const [line, top] of Object.entries(tops)) {
    const element = document.createElement("p");
    element.dataset.sourceLine = line;
    // getBoundingClientRect is relative to the viewport
    element.getBoundingClientRect = () => ({ top: top - window.scrollY }) as DOMRect;
    document.body.appendChild(element);
  }
}

function target(): number {
  expect(scrollTo).toHaveBeenCalledOnce();
  const [options] = scrollTo.mock.calls[0];
  expect(options.behavior).toBe("smooth");
  return options.top;
}

beforeEach(() => {
  scrollTo = vi.fn();
  vi.spyOn(window, "scrollTo").mockImplementation(scrollTo as never);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(SCROLL_HEIGHT);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(CLIENT_HEIGHT);
  vi.spyOn(window, "scrollY", "get").mockReturnValue(SCROLL_Y);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// 20 buffer lines (0-based 0..19); lines 2, 6 and 12 have elements
const LEN = 20;
const TOPS = { 2: 500, 6: 900, 12: 1500 };

describe("middle", () => {
  beforeEach(() => layout(TOPS));

  test("cursor on the first line scrolls to the top", () => {
    syncScroll.middle({ cursor: 1, winline: 1, winheight: 40, len: LEN });
    expect(target()).toBe(0);
  });

  test("cursor on the last line scrolls to the bottom", () => {
    syncScroll.middle({ cursor: LEN, winline: 30, winheight: 40, len: LEN });
    expect(target()).toBe(SCROLL_HEIGHT);
  });

  test("a tagged line is centred", () => {
    // cursor is 1-based: line 7 is data-source-line 6
    syncScroll.middle({ cursor: 7, winline: 10, winheight: 40, len: LEN });
    expect(target()).toBe(900 - CLIENT_HEIGHT / 2);
  });

  test("an untagged line is interpolated between its neighbours", () => {
    // line 4 is halfway between line 2 (500) and line 6 (900)
    syncScroll.middle({ cursor: 5, winline: 10, winheight: 40, len: LEN });
    expect(target()).toBe(700 - CLIENT_HEIGHT / 2);

    scrollTo.mockClear();
    // line 8 is a third of the way from line 6 (900) to line 12 (1500)
    syncScroll.middle({ cursor: 9, winline: 10, winheight: 40, len: LEN });
    expect(target()).toBe(1100 - CLIENT_HEIGHT / 2);
  });

  test("after the last tagged line it interpolates towards the bottom of the page", () => {
    // line 15: between line 12 (1500) and the last line 19 (scrollHeight)
    syncScroll.middle({ cursor: 16, winline: 10, winheight: 40, len: LEN });
    expect(target()).toBeCloseTo(1500 + ((SCROLL_HEIGHT - 1500) * 3) / 7 - CLIENT_HEIGHT / 2);
  });

  test("before the first tagged line it interpolates from the top of the page", () => {
    // line 1: between the top (0) and line 2 (500)
    syncScroll.middle({ cursor: 2, winline: 2, winheight: 40, len: LEN });
    expect(target()).toBe(250 - CLIENT_HEIGHT / 2);
  });
});

describe("top", () => {
  beforeEach(() => layout(TOPS));

  test("puts the first line of the editor window at the top", () => {
    // cursor on line 11 (1-based) at screen row 5: the window starts at
    // line 7, which is data-source-line 6
    syncScroll.top({ cursor: 11, winline: 5, winheight: 40, len: LEN });
    expect(target()).toBe(900);
  });

  test("interpolates an untagged first window line", () => {
    // window starts at line 5 (1-based), data-source-line 4, between
    // line 2 (500) and 6 (900)
    syncScroll.top({ cursor: 8, winline: 4, winheight: 40, len: LEN });
    expect(target()).toBe(700);
  });

  test("first and last lines", () => {
    syncScroll.top({ cursor: 1, winline: 1, winheight: 40, len: LEN });
    expect(target()).toBe(0);
    scrollTo.mockClear();
    syncScroll.top({ cursor: LEN, winline: 40, winheight: 40, len: LEN });
    expect(target()).toBe(SCROLL_HEIGHT);
  });
});

describe("relative", () => {
  beforeEach(() => layout(TOPS));

  test("keeps the cursor line at the same height as in the editor", () => {
    // cursor a quarter down the editor window
    syncScroll.relative({ cursor: 13, winline: 10, winheight: 40, len: LEN });
    expect(target()).toBe(1500 - CLIENT_HEIGHT / 4);
  });

  test("first and last lines", () => {
    syncScroll.relative({ cursor: 1, winline: 1, winheight: 40, len: LEN });
    expect(target()).toBe(0);
    scrollTo.mockClear();
    syncScroll.relative({ cursor: LEN, winline: 40, winheight: 40, len: LEN });
    expect(target()).toBe(SCROLL_HEIGHT);
  });
});

// the backwards search once stopped at line 1, so lines after the first
// element were interpolated from the top of the page instead
test("an element on line 0 is used for interpolation", () => {
  layout({ 0: 100, 2: 500 });
  syncScroll.middle({ cursor: 2, winline: 2, winheight: 40, len: LEN });
  // line 1 is halfway between line 0 (100) and line 2 (500)
  expect(target()).toBe(300 - CLIENT_HEIGHT / 2);
});

test("finds the elements rendered by the markdown renderer", () => {
  const src = ["# Title", "", "intro", "", "## Section", "", "body", "", "end"].join("\n");
  document.body.innerHTML = createRenderer({}).render(src);
  const tops: Record<string, number> = { "0": 0, "2": 80, "4": 400, "6": 480, "8": 900 };
  for (const element of document.querySelectorAll<HTMLElement>("[data-source-line]")) {
    const top = tops[element.dataset.sourceLine!];
    element.getBoundingClientRect = () => ({ top: top - window.scrollY }) as DOMRect;
  }
  // cursor on "## Section" (1-based line 5)
  syncScroll.middle({ cursor: 5, winline: 5, winheight: 40, len: 9 });
  expect(target()).toBe(400 - CLIENT_HEIGHT / 2);
});
