import { describe, expect, test } from "vitest";

import { html, render } from "../render";

const local = (src: string) => `/_assets/${encodeURIComponent(src)}`;

function img(src: string) {
  const image = render(src).querySelector("img");
  expect(image, src).not.toBeNull();
  return image!;
}

describe("markdown images", () => {
  test("the src is URI-encoded into /_assets/", () => {
    expect(img("![logo](./images/logo.png)").getAttribute("src")).toBe("/_assets/.%2Fimages%2Flogo.png");
  });

  test.each(["./images/logo.png", "images/logo.png", "../logo.png", "/home/me/logo.png", "C:\\pics\\logo.png"])(
    "local path %s is served by the preview server",
    (src) => {
      const image = img(`![logo](${src})`);
      const served = image.getAttribute("src")!;
      expect(served).toMatch(/^\/_assets\/[^/]*$/);
      // markdown-it percent-encodes link destinations before the page encodes
      // them again; the server decodes twice
      const path = served.slice("/_assets/".length);
      expect(decodeURIComponent(decodeURIComponent(path))).toBe(src);
    },
  );

  test.each([
    "http://example.com/a.png",
    "https://example.com/a.png?size=2#x",
    "//cdn.example.com/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
  ])("remote src %s is left alone", (src) => {
    expect(img(`![remote](${src})`).getAttribute("src")).toBe(src);
  });

  test("keeps the alt text and title", () => {
    const image = img('![a *nice* logo](logo.png "The title")');
    expect(image.getAttribute("alt")).toBe("a nice logo");
    expect(image.getAttribute("title")).toBe("The title");
  });

  test("escapes the alt text and title", () => {
    const out = html('![say "hi" <b>&</b>](logo.png "a \\"b\\" <c>")');
    expect(out).not.toContain("<b>");
    const image = render('![say "hi" <b>&</b>](logo.png "a \\"b\\" <c>")').querySelector("img")!;
    // inline HTML is kept as text
    expect(image.getAttribute("alt")).toBe('say "hi" <b>&</b>');
    expect(image.getAttribute("title")).toBe('a "b" <c>');
    expect(image.attributes).toHaveLength(3);
  });

  test.each([
    ["=300x200", "300", "200"],
    ["=300x", "300", null],
    ["=x200", null, "200"],
    ["=50%x", "50%", null],
    ["=50%x25%", "50%", "25%"],
  ])("size %s sets width and height", (size, width, height) => {
    const image = img(`![logo](images/logo.png ${size})`);
    expect(image.getAttribute("src")).toBe(local("images/logo.png"));
    expect(image.getAttribute("alt")).toBe("logo");
    expect(image.getAttribute("width")).toBe(width);
    expect(image.getAttribute("height")).toBe(height);
  });

  test("size after a title", () => {
    const image = img('![logo](logo.png "The title" =10x20)');
    expect(image.getAttribute("src")).toBe(local("logo.png"));
    expect(image.getAttribute("title")).toBe("The title");
    expect(image.getAttribute("width")).toBe("10");
    expect(image.getAttribute("height")).toBe("20");
  });

  test("size on a remote image", () => {
    const image = img("![r](https://example.com/a.png =64x)");
    expect(image.getAttribute("src")).toBe("https://example.com/a.png");
    expect(image.getAttribute("width")).toBe("64");
  });

  test("several sized images in one paragraph", () => {
    const images = render("![a](a.png =1x) and ![b](b.png =x2)").querySelectorAll("img");
    expect([...images].map((i) => [i.getAttribute("src"), i.getAttribute("width"), i.getAttribute("height")])).toEqual([
      [local("a.png"), "1", null],
      [local("b.png"), null, "2"],
    ]);
  });

  test("an empty size is not a size", () => {
    const root = render("![logo](logo.png =x)");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent?.trim()).toBe("![logo](logo.png =x)");
  });
});

describe("HTML images", () => {
  test("a local src in an HTML block is rewritten", () => {
    const image = img('<img width="52" src="images/logo.svg" alt="tiny logo">');
    expect(image.getAttribute("src")).toBe(local("images/logo.svg"));
    expect(image.getAttribute("width")).toBe("52");
    expect(image.getAttribute("alt")).toBe("tiny logo");
  });

  test("a local src in inline HTML is rewritten", () => {
    const root = render('Logo: <img src="/abs/logo.png" alt="x"> inline');
    const image = root.querySelector("p > img");
    expect(image?.getAttribute("src")).toBe(local("/abs/logo.png"));
    expect(root.querySelector("p")?.textContent).toBe("Logo:  inline");
  });

  test("single quoted src", () => {
    expect(img("<img src='my logo.png' alt='x'>").getAttribute("src")).toBe(local("my logo.png"));
  });

  test("a quote of the other kind inside src", () => {
    expect(img(`<img src="it's.png">`).getAttribute("src")).toBe(local("it's.png"));
  });

  test.each(["https://example.com/a.png", "http://example.com/a.png", "//cdn.example.com/a.png", "data:image/png;base64,AAAA"])(
    "remote src %s is left alone",
    (src) => {
      expect(img(`<p>x <img src="${src}"></p>`).getAttribute("src")).toBe(src);
      expect(img(`text <img src="${src}">`).getAttribute("src")).toBe(src);
    },
  );

  test("every image in a block is rewritten", () => {
    const root = render('<div>\n<img src="a.png">\n<img src="https://e.com/b.png">\n<img src="c.png">\n</div>');
    expect([...root.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      local("a.png"),
      "https://e.com/b.png",
      local("c.png"),
    ]);
  });
});
