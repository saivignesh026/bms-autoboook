/* Capture routines from BMS Full Auto-Booker + Discord v67.
 * html2canvas 1.4.1 is bundled locally and loaded before this script.
 */
(() => {
  'use strict';

  async function seat() {
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      allowTaint: true,
      scale: 0.8,
      backgroundColor: '#ffffff'
    });
    return canvas.toDataURL('image/jpeg', 0.6);
  }

  async function getQRBase64() {
      const svgs = document.querySelectorAll('svg');
      for (let svg of svgs) {
          const paths = svg.querySelectorAll('path');
          const rects = svg.querySelectorAll('rect');
          if (paths.length > 5 || rects.length > 10) {
              let svgText = new XMLSerializer().serializeToString(svg);
              if (!svgText.includes('xmlns=')) svgText = svgText.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
              svgText = svgText.replace(/(<svg[^>]*>)/i, '$1<rect width="100%" height="100%" fill="white"/>');
              const base64Svg = "data:image/svg+xml;base64," + window.btoa(unescape(encodeURIComponent(svgText)));

              return new Promise((resolve) => {
                  const img = new Image();
                  img.onload = () => {
                      const canvas = document.createElement('canvas');
                      canvas.width = img.width > 100 ? img.width : 300;
                      canvas.height = img.height > 100 ? img.height : 300;
                      const ctx = canvas.getContext('2d');
                      ctx.fillStyle = 'white';
                      ctx.fillRect(0, 0, canvas.width, canvas.height);
                      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                      resolve(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
                  };
                  img.src = base64Svg;
              });
          }
      }

      const canvases = document.querySelectorAll('canvas');
      for (let c of canvases) {
          if (c.width > 50 && c.height > 50 && !c.className.includes('bms-target-box')) {
              return c.toDataURL('image/jpeg', 0.9).split(',')[1];
          }
      }

      let targetElement = document.querySelector('img[alt*="QR" i]') || document.querySelector('img[src*="data:image"]');
      if (targetElement && targetElement.parentElement) targetElement = targetElement.parentElement;
      if (!targetElement) targetElement = document.body;

      const canvas = await html2canvas(targetElement, { useCORS: true, allowTaint: true, scale: 1.2, backgroundColor: "#ffffff" });
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }

  async function qr() {
    const base64 = await getQRBase64();
    return base64 ? { data: 'data:image/jpeg;base64,' + base64, kind: 'qr' } : null;
  }

  globalThis.BMSCapture = { seat, qr, getQRBase64 };
})();
