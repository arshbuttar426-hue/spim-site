/*
 * Client-side QR rendering.
 *
 * The capsule link can carry the decryption key in its fragment, so it must
 * never be sent anywhere. This renders it locally instead of asking a QR
 * service to draw it. The encoder is loaded on first use, so a visitor who
 * never taps QR downloads none of it.
 */
(function () {
  'use strict';

  var SRC = '/js/vendor/qrcode.min.js';
  var loading = null;

  function load() {
    if (window.qrcode) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = function () {
        if (window.qrcode) resolve();
        else reject(new Error('qr encoder unavailable'));
      };
      s.onerror = function () { reject(new Error('qr encoder unavailable')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  window.SpimQR = {
    /* Renders text into an <img> as a data: URL. Nothing leaves the browser. */
    render: function (img, text) {
      return load().then(function () {
        var qr = window.qrcode(0, 'M'); /* 0 = pick the smallest version that fits */
        qr.addData(text);
        qr.make();
        img.src = qr.createDataURL(4, 8);
        return img;
      });
    }
  };
})();
