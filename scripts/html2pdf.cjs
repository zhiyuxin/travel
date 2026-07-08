const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  const htmlPath = path.resolve(__dirname, '..', 'output', '西安烟台7日亲子自驾游.html');
  const pdfPath = path.resolve(__dirname, '..', 'output', '西安烟台7日亲子自驾游.pdf');
  
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Users\\Administrator\\.cache\\puppeteer\\chrome-headless-shell\\win64-150.0.7871.24\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Set viewport to simulate a reasonable screen width
  await page.setViewport({ width: 1200, height: 900 });
  
  // Load the HTML file
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), {
    waitUntil: 'networkidle0',
    timeout: 30000
  });
  
  // Generate PDF
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '0mm',
      right: '0mm',
      bottom: '0mm',
      left: '0mm'
    },
    preferCSSPageSize: true
  });
  
  await browser.close();
  console.log('PDF 已生成：' + pdfPath);
})();
