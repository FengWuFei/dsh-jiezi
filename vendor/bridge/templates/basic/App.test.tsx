import { expect, open, test } from "nsh/test";

test("counts two increments", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("0");
  await app.press("Increment");
  await app.press("Increment");
  expect(app.texts()).toContain("2");
});
