import { chromium } from 'playwright'
import { create } from 'playcast'

const ffmpegDir = process.env.FFMPEG_DIR || 'node_modules/ffmpeg-static'
process.env.PATH = ffmpegDir + ';' + process.env.PATH
const token = process.argv[2]
const out = process.argv[3] || './collaboration.gif'
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return
    const dot = document.createElement('div')
    dot.id = '__demo_cursor'
    dot.style.cssText = 'position:fixed;left:640px;top:360px;width:16px;height:16px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 0 0 5px rgba(255,77,79,.25);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:left .08s linear,top .08s linear'
    document.documentElement.appendChild(dot)
    window.addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' })
    window.addEventListener('mousedown', () => { dot.style.background = '#1677ff'; dot.style.transform = 'translate(-50%,-50%) scale(.8)' })
    window.addEventListener('mouseup', () => { dot.style.background = '#ff4d4f'; dot.style.transform = 'translate(-50%,-50%) scale(1)' })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install()
})
await page.goto(`http://127.0.0.1:13087/?token=${token}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5500)
const cont = page.getByRole('button', { name: '继续' }).first()
if (await cont.count()) { await cont.click({ force: true }); await page.waitForTimeout(1000) }
const cast = create(page, { scale: 1.5, settleMs: 400, zoomTo: false, showActions: false })
await cast.start(out)
await page.waitForTimeout(500)
const collab = page.locator('[aria-label="协作网络"]').first()
await page.mouse.move(80, 170, { steps: 15 })
await collab.click({ force: true })
await page.waitForTimeout(1200)
await page.evaluate(() => { const el = document.querySelector('[data-slot="main"]') || document.querySelector('main'); if (el) { el.style.transition='transform .6s ease'; el.style.transformOrigin='50% 40%'; el.style.transform='scale(1.12)' } })
await page.waitForTimeout(500)
const task = page.getByText('Review onboarding flow', { exact: true }).first()
if (await task.count()) { const box = await task.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 }); await page.waitForTimeout(400); await task.click({ force: true }) }
await page.waitForTimeout(1400)
await page.evaluate(() => { const el = document.querySelector('[data-slot="main"]') || document.querySelector('main'); if (el) el.style.transform='scale(1)' })
await page.waitForTimeout(600)
await page.mouse.move(640, 500, { steps: 10 })
await page.mouse.wheel(0, 420)
await page.waitForTimeout(1000)
await page.mouse.wheel(0, -200)
await page.waitForTimeout(800)
console.log(JSON.stringify(await cast.stop()))
await browser.close()
