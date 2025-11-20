import express from "express";
import puppeteer from "puppeteer";

const app = express();

app.get("/", (req, res) => {
  res.send("Puppeteer Proxy Online");
});

app.get("/screenshot", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.send("Missing ?url=");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox"
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(url, { waitUntil: "networkidle0" });

  const buffer = await page.screenshot({ type: "png" });

  await browser.close();
  res.set("Content-Type", "image/png");
  res.send(buffer);
});

app.listen(3000, () => console.log("Server running on port 3000"));
