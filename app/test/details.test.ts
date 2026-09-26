import { expect, test } from "vitest";

import { replaceKeepingDetails } from "@/lib/details";

const DOC = (text: string) =>
  `<details><summary>one</summary>${text}</details><details open><summary>two</summary></details>`;

test("a re-render keeps the <details> the reader opened and closed", () => {
  const body = document.createElement("section");
  replaceKeepingDetails(body, DOC("first"));
  const [one, two] = body.querySelectorAll("details");
  expect([one.open, two.open]).toEqual([false, true]);
  one.open = true;
  two.open = false;

  replaceKeepingDetails(body, DOC("edited"));
  const [newOne, newTwo] = body.querySelectorAll("details");
  expect(newOne).not.toBe(one);
  expect(newOne.textContent).toContain("edited");
  expect([newOne.open, newTwo.open]).toEqual([true, false]);
});

test("new <details> keep the state they are written with", () => {
  const body = document.createElement("section");
  replaceKeepingDetails(body, "<p>none yet</p>");
  replaceKeepingDetails(body, DOC("x"));
  const [one, two] = body.querySelectorAll("details");
  expect([one.open, two.open]).toEqual([false, true]);
});
