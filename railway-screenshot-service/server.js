const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Screenshot
app.post('/screenshot', async (req, res) => {
  const { url, viewport = { width: 1440, height: 900 } } = req.body;
  
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  });

  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    // Remover banners de cookie
    await page.addInitScript(() => {
      const remove = () => {
        document.querySelectorAll('[class*="cookie"], [class*="gdpr"], .chat-widget').forEach(el => el.remove());
      };
      remove();
      setInterval(remove, 1000);
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({ type: 'png' });
    
    res.setHeader('Content-Type', 'image/png');
    res.send(screenshot);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Screenshot service on port ${PORT}`));