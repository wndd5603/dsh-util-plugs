import { chromium } from 'playwright'
import { create } from 'playcast'

const ffmpegDir = process.env.FFMPEG_DIR || 'node_modules/ffmpeg-static'
process.env.PATH = ffmpegDir + ';' + process.env.PATH
const token = process.argv[2]
const out = process.argv[3] || './plugin-console.gif'
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
const plugin = page.locator('[aria-label="插件控制台"]').first()
if (await plugin.count()) { const box = await plugin.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 }); await page.waitForTimeout(300); await plugin.click({ force: true }); await page.waitForTimeout(1200) }
await page.evaluate(() => { const el = document.querySelector('[data-slot="main"]') || document.querySelector('main'); if (el) { el.style.transition='transform .6s ease'; el.style.transformOrigin='50% 30%'; el.style.transform='scale(1.1)' } })
await page.waitForTimeout(700)
await page.mouse.move(640, 380, { steps: 20 }); await page.waitForTimeout(500)
await page.mouse.wheel(0, 320); await page.waitForTimeout(1200)
await page.mouse.wheel(0, -180); await page.waitForTimeout(600)
const collab = page.locator('[aria-label="协作网络"]').first()
if (await collab.count()) await collab.click({ force: true }).catch(() => {})
await page.waitForTimeout(1200)
await page.evaluate(() => { const el = document.querySelector('[data-slot="main"]') || document.querySelector('main'); if (el) el.style.transform='scale(1)' })
await page.waitForTimeout(500)
console.log(JSON.stringify(await cast.stop()))
await browser.close()
