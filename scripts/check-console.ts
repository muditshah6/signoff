/** Visits every screen as Priya and prints browser console errors/warnings. Needs a running dev server. */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3100";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  const seen: string[] = [];
  let where = "";
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) seen.push(`[${where}] ${m.type()}: ${m.text().slice(0, 600)}`); });
  page.on("pageerror", (e) => seen.push(`[${where}] pageerror: ${e.message.slice(0, 600)}`));
  await page.goto(`${BASE}/login`);
  await page.selectOption("#user_id", await page.locator("#user_id option").filter({ hasText: /Priya Raman/ }).first().getAttribute("value"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/clients");
  const hrefs = new Set<string>(["/clients", "/audit", "/connect"]);
  for (const h of await page.locator("a[href^='/reviews/'], a[href*='/memory']").evaluateAll((a) => a.map((x) => (x as HTMLAnchorElement).getAttribute("href")!))) hrefs.add(h);
  for (const h of [...hrefs]) {
    where = h;
    await page.goto(`${BASE}${h}`);
    await page.waitForLoadState("networkidle");
    if (h.startsWith("/reviews/")) { where = `${h}/edit`; await page.goto(`${BASE}${h}/edit`); await page.waitForLoadState("networkidle"); }
  }
  console.log(seen.length ? seen.join("\n") : "no console errors or warnings");
  await browser.close();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
