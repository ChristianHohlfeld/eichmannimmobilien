(function () {
  var MEASUREMENT_ID = ''; // set to 'G-XXXXXXXX' to enable GA4
  if (!MEASUREMENT_ID || MEASUREMENT_ID.indexOf('G-') !== 0) return;
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(s);
})();
